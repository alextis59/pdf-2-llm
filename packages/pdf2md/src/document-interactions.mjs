import {
  isPdfDictionary,
  pdfNameValue,
  pdfTextStringValue,
  resolvePdfValue
} from "./pdf-parser.mjs";
import { bytesToBase64 } from "./runtime.mjs";

const fieldFlagBits = Object.freeze({
  readOnly: 1,
  required: 2,
  noExport: 4,
  radio: 1 << 15,
  pushButton: 1 << 16
});

export class PdfDocumentInteractionLimitError extends Error {
  constructor(tree, limit, actual) {
    super(`${tree} tree depth exceeds the document interaction limit.`);
    this.name = "PdfDocumentInteractionLimitError";
    this.code = "pdf.interactions.depth_limit_exceeded";
    this.offset = null;
    this.details = { tree, limit, actual };
  }
}

export function extractDocumentInteractions(pdfDocument, options = {}) {
  if (!pdfDocument) {
    return emptyDocumentInteractions();
  }

  const annotationIndex = createAnnotationPageIndex(pdfDocument);
  const annotations = extractAnnotations(pdfDocument, annotationIndex);
  const maxDepth = options.maxDepth ?? 100;
  const forms = extractForms(pdfDocument, annotationIndex, maxDepth);
  const signatures = extractSignatures(forms.fields);
  const attachments = extractAttachments(pdfDocument, {
    extractAssets: options.extractAttachmentAssets === true,
    maxDepth
  });
  const elementsByPage = mergeElementMaps(forms.elementsByPage, annotations.elementsByPage);

  return {
    forms: stripElementMap(forms),
    annotations: stripElementMap(annotations),
    attachments: attachments.diagnostics,
    signatures,
    assets: attachments.assets,
    elementsByPage
  };
}

function emptyDocumentInteractions() {
  return {
    forms: emptyFormsDiagnostics(),
    annotations: emptyAnnotationDiagnostics(),
    attachments: emptyAttachmentDiagnostics(),
    signatures: emptySignatureDiagnostics(),
    assets: [],
    elementsByPage: new Map()
  };
}

function emptyFormsDiagnostics() {
  return {
    present: false,
    total: 0,
    filled: 0,
    checkboxes: 0,
    radioButtons: 0,
    fields: [],
    xfa: {
      present: false,
      status: "absent",
      reason: null
    }
  };
}

function emptyAnnotationDiagnostics() {
  return {
    total: 0,
    links: 0,
    texts: 0,
    annotations: [],
    pages: []
  };
}

function emptyAttachmentDiagnostics() {
  return {
    total: 0,
    extractedSidecars: 0,
    files: []
  };
}

function emptySignatureDiagnostics() {
  return {
    total: 0,
    validationStatus: "not-validated",
    signatures: []
  };
}

function stripElementMap(value) {
  const { elementsByPage, ...diagnostics } = value;
  return diagnostics;
}

function mergeElementMaps(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [pageIndex, elements] of map.entries()) {
      merged.set(pageIndex, [...(merged.get(pageIndex) ?? []), ...elements]);
    }
  }
  return merged;
}

function extractForms(pdfDocument, annotationIndex, maxDepth) {
  const acroFormObject = resolveDictionaryObject(
    pdfDocument.catalog?.value?.entries?.AcroForm,
    pdfDocument.getObject
  );
  if (!acroFormObject) {
    return {
      ...emptyFormsDiagnostics(),
      elementsByPage: new Map()
    };
  }

  const acroForm = acroFormObject.value;
  const fields = [];
  const seen = new Set();
  const fieldRefs = arrayItems(acroForm.entries.Fields, pdfDocument.getObject);
  for (const fieldRef of fieldRefs) {
    walkFieldTree(
      fieldRef,
      inheritedFieldState(),
      pdfDocument,
      annotationIndex,
      fields,
      seen,
      0,
      maxDepth
    );
  }

  fields.forEach((field, index) => {
    field.fieldIndex = index;
  });

  const elementsByPage = new Map();
  for (const field of fields) {
    if (!Number.isInteger(field.pageIndex)) {
      continue;
    }
    const element = formFieldElement(field);
    const elements = elementsByPage.get(field.pageIndex) ?? [];
    elements.push(element);
    elementsByPage.set(field.pageIndex, elements);
  }

  return {
    present: true,
    total: fields.length,
    filled: fields.filter((field) => field.valueSource === "V" && field.value !== null).length,
    checkboxes: fields.filter((field) => field.buttonType === "checkbox").length,
    radioButtons: fields.filter((field) => field.buttonType === "radio").length,
    fields,
    xfa: xfaDiagnostics(acroForm.entries.XFA != null),
    elementsByPage
  };
}

function inheritedFieldState() {
  return {
    fullName: null,
    fieldType: null,
    flags: 0
  };
}

function walkFieldTree(
  fieldRef,
  inherited,
  pdfDocument,
  annotationIndex,
  fields,
  seen,
  depth,
  maxDepth
) {
  const fieldObject = resolveDictionaryObject(fieldRef, pdfDocument.getObject);
  if (!fieldObject) {
    return;
  }
  const key = objectKey(fieldObject) ?? refKey(fieldRef);
  if (key && seen.has(key)) {
    return;
  }
  if (key) {
    seen.add(key);
  }
  enforceInteractionDepth("AcroForm", depth, maxDepth);

  const field = fieldObject.value;
  const localName = textValue(field.entries.T, pdfDocument.getObject);
  const fullName = joinFieldName(inherited.fullName, localName);
  const fieldType = pdfNameValue(resolvePdfValue(field.entries.FT, pdfDocument.getObject)) ?? inherited.fieldType;
  const flags =
    typeof resolvePdfValue(field.entries.Ff, pdfDocument.getObject) === "number"
      ? resolvePdfValue(field.entries.Ff, pdfDocument.getObject)
      : inherited.flags;
  const nextInherited = {
    fullName,
    fieldType,
    flags
  };
  const children = arrayItems(field.entries.Kids, pdfDocument.getObject)
    .map((kidRef) => ({
      ref: kidRef,
      object: resolveDictionaryObject(kidRef, pdfDocument.getObject)
    }))
    .filter((child) => child.object);
  const structuralChildren = children.filter((child) => isStructuralFieldChild(child.object.value));

  if (fieldType && (children.length === 0 || structuralChildren.length === 0 || field.entries.V != null)) {
    fields.push(createFieldDiagnostic(fieldObject, fieldRef, nextInherited, children, pdfDocument, annotationIndex));
  }

  for (const child of structuralChildren) {
    walkFieldTree(
      child.ref,
      nextInherited,
      pdfDocument,
      annotationIndex,
      fields,
      seen,
      depth + 1,
      maxDepth
    );
  }
}

function isStructuralFieldChild(dictionary) {
  const subtype = pdfNameValue(dictionary.entries.Subtype);
  return (
    subtype !== "Widget" ||
    dictionary.entries.T != null ||
    dictionary.entries.FT != null ||
    dictionary.entries.Kids != null
  );
}

function createFieldDiagnostic(fieldObject, fieldRef, inherited, children, pdfDocument, annotationIndex) {
  const field = fieldObject.value;
  const value = fieldValue(field.entries.V, pdfDocument.getObject);
  const defaultValue = fieldValue(field.entries.DV, pdfDocument.getObject);
  const fieldType = normalizedFieldType(inherited.fieldType);
  const widget = selectFieldWidget(fieldObject, fieldRef, children, annotationIndex);
  const button =
    fieldType === "button"
      ? buttonState(field, widget.dictionary, inherited.flags, value, pdfDocument.getObject)
      : {};
  const rect = rectFromValue(
    widget.dictionary.entries.Rect ?? field.entries.Rect,
    pdfDocument.getObject
  );
  const signature = inherited.fieldType === "Sig" ? signatureValue(field.entries.V, pdfDocument.getObject) : null;

  return removeNullish({
    fieldIndex: 0,
    objectNumber: fieldObject.objectNumber ?? null,
    generationNumber: fieldObject.generationNumber ?? null,
    name: inherited.fullName ?? fallbackFieldName(fieldObject),
    label:
      textValue(field.entries.TU, pdfDocument.getObject) ??
      textValue(field.entries.TM, pdfDocument.getObject) ??
      inherited.fullName ??
      null,
    fieldType,
    rawFieldType: inherited.fieldType,
    value: value.value,
    valueSource: value.source,
    defaultValue: defaultValue.value,
    flags: inherited.flags,
    readOnly: Boolean(inherited.flags & fieldFlagBits.readOnly),
    required: Boolean(inherited.flags & fieldFlagBits.required),
    noExport: Boolean(inherited.flags & fieldFlagBits.noExport),
    pageIndex: widget.pageIndex,
    ...rect,
    ...button,
    ...optionalProperty("signature", signature)
  });
}

function selectFieldWidget(fieldObject, fieldRef, children, annotationIndex) {
  const childWidgets = children.filter(
    (child) => pdfNameValue(child.object.value.entries.Subtype) === "Widget"
  );
  const candidates = [
    ...(pdfNameValue(fieldObject.value.entries.Subtype) === "Widget"
      ? [{ ref: fieldRef, object: fieldObject }]
      : []),
    ...childWidgets
  ].map((candidate) => ({
    ...candidate,
    pageIndex: firstPageIndexForRefs(
      [refKey(candidate.ref), objectKey(candidate.object)].filter(Boolean),
      annotationIndex
    )
  }));
  const selected = candidates.find((candidate) => Number.isInteger(candidate.pageIndex)) ?? candidates[0];
  const fallbackPageIndex = firstPageIndexForRefs(
    [
      refKey(fieldRef),
      objectKey(fieldObject),
      ...childWidgets.flatMap((child) => [refKey(child.ref), objectKey(child.object)])
    ].filter(Boolean),
    annotationIndex
  );

  return {
    dictionary: selected?.object.value ?? fieldObject.value,
    pageIndex: selected?.pageIndex ?? fallbackPageIndex
  };
}

function fallbackFieldName(fieldObject) {
  if (Number.isInteger(fieldObject.objectNumber)) {
    return `field-${fieldObject.objectNumber}-${fieldObject.generationNumber ?? 0}`;
  }
  return "field";
}

function joinFieldName(parent, localName) {
  if (!localName) {
    return parent ?? null;
  }
  return parent ? `${parent}.${localName}` : localName;
}

function normalizedFieldType(raw) {
  switch (raw) {
    case "Tx":
      return "text";
    case "Btn":
      return "button";
    case "Ch":
      return "choice";
    case "Sig":
      return "signature";
    default:
      return raw ?? "unknown";
  }
}

function fieldValue(value, getObject) {
  if (value == null) {
    return {
      source: "none",
      value: null
    };
  }
  const resolved = resolvePdfValue(value, getObject);
  return {
    source: "V",
    value: scalarValue(resolved, getObject)
  };
}

function scalarValue(value, getObject) {
  const resolved = resolvePdfValue(value, getObject);
  if (typeof resolved === "number" || typeof resolved === "boolean") {
    return String(resolved);
  }
  if (typeof resolved === "string" || resolved?.type === "hex-string") {
    return pdfTextStringValue(resolved);
  }
  const name = pdfNameValue(resolved);
  if (name) {
    return name;
  }
  return null;
}

function buttonState(field, widget, flags, value, getObject) {
  const buttonType = flags & fieldFlagBits.radio ? "radio" : flags & fieldFlagBits.pushButton ? "pushbutton" : "checkbox";
  const appearanceState = pdfNameValue(
    resolvePdfValue(widget.entries.AS ?? field.entries.AS, getObject)
  );
  const state = appearanceState ?? value.value ?? null;
  const checked = buttonType === "checkbox" ? state != null && state !== "Off" : undefined;
  const selectedValue = buttonType === "radio" ? value.value : undefined;
  return removeNullish({
    buttonType,
    state,
    checked,
    selectedValue
  });
}

function xfaDiagnostics(present) {
  return {
    present,
    status: present ? "unsupported" : "absent",
    reason: present ? "XFA packets are detected but not parsed." : null
  };
}

function formFieldElement(field) {
  return removeNullish({
    type: "form-field",
    name: field.name,
    ...optionalProperty("label", field.label),
    ...optionalProperty("value", field.value),
    fieldType: field.fieldType,
    buttonType: field.buttonType,
    checked: field.checked,
    selectedValue: field.selectedValue,
    x: field.x,
    y: field.y,
    width: field.width,
    height: field.height
  });
}

function extractSignatures(fields) {
  const signatures = fields
    .filter((field) => field.fieldType === "signature")
    .map((field, index) =>
      removeNullish({
        signatureIndex: index,
        fieldName: field.name,
        label: field.label,
        objectNumber: field.objectNumber,
        generationNumber: field.generationNumber,
        pageIndex: field.pageIndex,
        validationStatus: "not-validated",
        ...field.signature
      })
    );
  return {
    total: signatures.length,
    validationStatus: "not-validated",
    signatures
  };
}

function signatureValue(value, getObject) {
  const object = resolveDictionaryObject(value, getObject);
  if (!object) {
    return null;
  }
  const dictionary = object.value;
  return removeNullish({
    valueObjectNumber: object.objectNumber ?? null,
    valueGenerationNumber: object.generationNumber ?? null,
    filter: pdfNameValue(resolvePdfValue(dictionary.entries.Filter, getObject)),
    subFilter: pdfNameValue(resolvePdfValue(dictionary.entries.SubFilter, getObject)),
    name: textValue(dictionary.entries.Name, getObject),
    reason: textValue(dictionary.entries.Reason, getObject),
    date: textValue(dictionary.entries.M, getObject),
    byteRange: numberArray(dictionary.entries.ByteRange, getObject)
  });
}

function extractAnnotations(pdfDocument, annotationIndex) {
  const elementsByPage = new Map();
  const annotations = [];
  for (const page of pdfDocument.pages ?? []) {
    const pageAnnotations = annotationsForPage(page, pdfDocument.getObject);
    for (const annotation of pageAnnotations) {
      if (annotation.subtype !== "Link" && annotation.subtype !== "Text") {
        continue;
      }
      const { keys, ...publicAnnotation } = annotation;
      publicAnnotation.annotationIndex = annotations.length;
      annotations.push(publicAnnotation);
      const element = annotationElement(publicAnnotation);
      const elements = elementsByPage.get(page.pageIndex) ?? [];
      elements.push(element);
      elementsByPage.set(page.pageIndex, elements);
    }
  }

  const pages = summarizeAnnotationsByPage(annotations, pdfDocument.pages ?? []);
  return {
    total: annotations.length,
    links: annotations.filter((annotation) => annotation.subtype === "Link").length,
    texts: annotations.filter((annotation) => annotation.subtype === "Text").length,
    annotations,
    pages,
    elementsByPage
  };
}

function createAnnotationPageIndex(pdfDocument) {
  const byKey = new Map();
  for (const page of pdfDocument.pages ?? []) {
    for (const annotation of annotationsForPage(page, pdfDocument.getObject)) {
      for (const key of annotation.keys) {
        byKey.set(key, page.pageIndex);
      }
    }
  }
  return byKey;
}

function annotationsForPage(page, getObject) {
  const values = arrayItems(page.annotationsRef, getObject);
  return values
    .map((annotationRef) => annotationDiagnostic(annotationRef, page.pageIndex, getObject))
    .filter(Boolean);
}

function annotationDiagnostic(annotationRef, pageIndex, getObject) {
  const object = resolveDictionaryObject(annotationRef, getObject);
  if (!object) {
    return null;
  }
  const dictionary = object.value;
  const rect = rectFromValue(dictionary.entries.Rect, getObject);
  const action = linkAction(dictionary.entries.A, getObject);
  return removeNullish({
    annotationIndex: 0,
    pageIndex,
    objectNumber: object.objectNumber ?? null,
    generationNumber: object.generationNumber ?? null,
    subtype: pdfNameValue(resolvePdfValue(dictionary.entries.Subtype, getObject)) ?? "Unknown",
    ...optionalProperty("contents", textValue(dictionary.entries.Contents, getObject)),
    ...optionalProperty("title", textValue(dictionary.entries.T, getObject)),
    ...optionalProperty("uri", action.uri),
    ...optionalProperty("actionType", action.actionType),
    ...rect,
    keys: [refKey(annotationRef), objectKey(object)].filter(Boolean)
  });
}

function linkAction(actionValue, getObject) {
  const action = resolvePdfValue(actionValue, getObject);
  if (!isPdfDictionary(action)) {
    return {
      actionType: null,
      uri: null
    };
  }
  return {
    actionType: pdfNameValue(resolvePdfValue(action.entries.S, getObject)),
    uri: textValue(action.entries.URI, getObject)
  };
}

function annotationElement(annotation) {
  return removeNullish({
    type: "annotation",
    subtype: annotation.subtype,
    contents: annotation.contents ?? annotation.uri,
    uri: annotation.uri,
    x: annotation.x,
    y: annotation.y,
    width: annotation.width,
    height: annotation.height
  });
}

function summarizeAnnotationsByPage(annotations, pages) {
  return pages
    .map((page) => {
      const pageAnnotations = annotations.filter((annotation) => annotation.pageIndex === page.pageIndex);
      return {
        pageIndex: page.pageIndex,
        total: pageAnnotations.length,
        links: pageAnnotations.filter((annotation) => annotation.subtype === "Link").length,
        texts: pageAnnotations.filter((annotation) => annotation.subtype === "Text").length
      };
    })
    .filter((page) => page.total > 0);
}

function extractAttachments(pdfDocument, options) {
  const embeddedFiles = resolvePdfValue(
    pdfDocument.catalog?.value?.entries?.Names,
    pdfDocument.getObject
  )?.entries?.EmbeddedFiles;
  if (!embeddedFiles) {
    return {
      diagnostics: emptyAttachmentDiagnostics(),
      assets: []
    };
  }

  const entries = collectNameTreeEntries(
    embeddedFiles,
    pdfDocument.getObject,
    new Set(),
    0,
    options.maxDepth
  );
  const assets = [];
  const files = entries.map((entry, index) => {
    const file = fileSpecDiagnostic(entry.value, entry.name, index, pdfDocument.getObject);
    if (options.extractAssets && file.embeddedFileObjectNumber !== null) {
      const asset = attachmentAsset(file, entry.value, index, pdfDocument.getObject);
      if (asset) {
        assets.push(asset);
        file.assetId = asset.id;
        file.assetPath = asset.path;
      }
    }
    file.extracted = Boolean(file.assetId);
    return file;
  });

  return {
    diagnostics: {
      total: files.length,
      extractedSidecars: files.filter((file) => file.extracted).length,
      files
    },
    assets
  };
}

function collectNameTreeEntries(rootValue, getObject, seen, depth, maxDepth) {
  const root = resolveDictionaryObject(rootValue, getObject);
  const key = objectKey(root) ?? refKey(rootValue);
  if (!root || (key && seen.has(key))) {
    return [];
  }
  if (key) {
    seen.add(key);
  }
  enforceInteractionDepth("EmbeddedFiles", depth, maxDepth);

  const entries = [];
  const names = arrayItems(root.value.entries.Names, getObject);
  for (let index = 0; index + 1 < names.length; index += 2) {
    entries.push({
      name: textValue(names[index], getObject) ?? `attachment-${entries.length + 1}`,
      value: names[index + 1]
    });
  }
  for (const kid of arrayItems(root.value.entries.Kids, getObject)) {
    entries.push(...collectNameTreeEntries(kid, getObject, seen, depth + 1, maxDepth));
  }
  return entries;
}

function enforceInteractionDepth(tree, depth, maxDepth) {
  if (depth > maxDepth) {
    throw new PdfDocumentInteractionLimitError(tree, maxDepth, depth);
  }
}

function fileSpecDiagnostic(fileSpecValue, name, index, getObject) {
  const fileSpec = resolveDictionaryObject(fileSpecValue, getObject);
  const dictionary = fileSpec?.value;
  const embeddedFile = embeddedFileObject(dictionary, getObject);
  const embeddedFileDictionary = embeddedFile?.value;
  const params = resolvePdfValue(embeddedFileDictionary?.entries?.Params, getObject);
  const mediaType = pdfNameValue(resolvePdfValue(embeddedFileDictionary?.entries?.Subtype, getObject));
  return removeNullish({
    attachmentIndex: index,
    name,
    fileName:
      textValue(dictionary?.entries?.UF, getObject) ??
      textValue(dictionary?.entries?.F, getObject) ??
      name,
    description: textValue(dictionary?.entries?.Desc, getObject),
    objectNumber: fileSpec?.objectNumber ?? null,
    generationNumber: fileSpec?.generationNumber ?? null,
    embeddedFileObjectNumber: embeddedFile?.objectNumber ?? null,
    embeddedFileGenerationNumber: embeddedFile?.generationNumber ?? null,
    size:
      (isPdfDictionary(params) && typeof params.entries.Size === "number" ? params.entries.Size : null) ??
      embeddedFile?.stream?.decodedLength ??
      null,
    mediaType: mediaType ?? "application/octet-stream",
    assetId: null,
    assetPath: null,
    extracted: false
  });
}

function attachmentAsset(file, fileSpecValue, index, getObject) {
  const embeddedFile = embeddedFileObject(resolveDictionaryObject(fileSpecValue, getObject)?.value, getObject);
  if (!embeddedFile?.stream?.decodedBytes) {
    return null;
  }
  const safeName = safeAssetFileName(file.fileName || file.name || `attachment-${index + 1}`);
  const id = `attachment-${index + 1}-${slugify(safeName)}`;
  return {
    id,
    kind: "attachment",
    path: `assets/attachments/${safeName}`,
    mediaType: file.mediaType ?? "application/octet-stream",
    content: bytesToBase64(embeddedFile.stream.decodedBytes),
    encoding: "base64",
    pageIndex: null
  };
}

function embeddedFileObject(fileSpecDictionary, getObject) {
  if (!isPdfDictionary(fileSpecDictionary)) {
    return null;
  }
  const ef = resolvePdfValue(fileSpecDictionary.entries.EF, getObject);
  if (!isPdfDictionary(ef)) {
    return null;
  }
  return (
    resolveObject(ef.entries.UF, getObject) ??
    resolveObject(ef.entries.F, getObject) ??
    resolveObject(ef.entries.DOS, getObject) ??
    resolveObject(ef.entries.Mac, getObject) ??
    resolveObject(ef.entries.Unix, getObject)
  );
}

function resolveDictionaryObject(value, getObject) {
  const object = resolveObject(value, getObject);
  if (object && isPdfDictionary(object.value)) {
    return object;
  }
  if (isPdfDictionary(value)) {
    return {
      value,
      objectNumber: null,
      generationNumber: null
    };
  }
  return null;
}

function resolveObject(value, getObject) {
  if (value?.type === "ref") {
    return getObject(value) ?? null;
  }
  if (value != null) {
    return {
      value,
      objectNumber: null,
      generationNumber: null
    };
  }
  return null;
}

function arrayItems(value, getObject) {
  const resolved = resolvePdfValue(value, getObject);
  return resolved?.type === "array" ? resolved.items : [];
}

function textValue(value, getObject) {
  const resolved = resolvePdfValue(value, getObject);
  if (typeof resolved === "string" || resolved?.type === "hex-string") {
    return pdfTextStringValue(resolved);
  }
  return null;
}

function numberArray(value, getObject) {
  const resolved = resolvePdfValue(value, getObject);
  if (resolved?.type !== "array" || !resolved.items.every((item) => typeof item === "number")) {
    return null;
  }
  return resolved.items;
}

function rectFromValue(value, getObject) {
  const rect = numberArray(value, getObject);
  if (!rect || rect.length < 4) {
    return {};
  }
  const [x1, y1, x2, y2] = rect;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

function firstPageIndexForRefs(keys, annotationIndex) {
  for (const key of keys) {
    if (annotationIndex.has(key)) {
      return annotationIndex.get(key);
    }
  }
  return null;
}

function objectKey(object) {
  if (!object || !Number.isInteger(object.objectNumber)) {
    return null;
  }
  return `${object.objectNumber}:${object.generationNumber ?? 0}`;
}

function refKey(ref) {
  if (ref?.type !== "ref") {
    return null;
  }
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

function removeNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

function optionalProperty(key, value) {
  return value == null ? {} : { [key]: value };
}

function safeAssetFileName(value) {
  const cleaned = String(value)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "attachment.bin";
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "attachment";
}
