import { decodePdfStringWithFont } from "./font-encoding.mjs";
import { bytesToLatin1 as runtimeBytesToLatin1 } from "./runtime.mjs";

const whitespacePattern = /\s/;
const delimiterChars = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const identityMatrix = Object.freeze([1, 0, 0, 1, 0, 0]);

export function extractContentStreamTextLines(streamText, options = {}) {
  const tokens = tokenizeContentStream(streamText);
  const state = createInitialState(options.resources);
  const stack = [];
  const operands = [];
  const lines = [];
  let textObjectId = 0;
  let lineSerial = 0;

  for (const token of tokens) {
    if (token.type !== "word") {
      operands.push(token);
      continue;
    }

    const context = {
      lines,
      operands,
      options,
      stack,
      state,
      textObjectId,
      lineSerial
    };
    executeOperator(token.value, context);
    textObjectId = context.textObjectId;
    lineSerial = context.lineSerial;
    operands.length = 0;
  }

  return lines.map(({ mergeKey, ...line }) => line);
}

export function extractContentStreamRulingLines(streamText, options = {}) {
  const tokens = tokenizeContentStream(streamText);
  const state = createInitialPathState();
  const stack = [];
  const operands = [];
  const lines = [];

  for (const token of tokens) {
    if (token.type !== "word") {
      operands.push(token);
      continue;
    }

    executePathOperator(token.value, {
      lines,
      operands,
      options,
      stack,
      state
    });
    operands.length = 0;
  }

  return options.mergeRulingLines === false ? lines : mergeRulingLines(lines, options);
}

export function extractContentStreamImageDraws(streamText, options = {}) {
  const tokens = tokenizeContentStream(streamText);
  const state = createInitialImageState(options.resources);
  const stack = [];
  const operands = [];
  const images = [];

  for (const token of tokens) {
    if (token.type !== "word") {
      operands.push(token);
      continue;
    }

    executeImageOperator(token.value, {
      images,
      operands,
      options,
      stack,
      state
    });
    operands.length = 0;
  }

  return images;
}

export function mergeRulingLines(rulingLines, options = {}) {
  const coordinateTolerance = options.mergeCoordinateTolerance ?? 0.5;
  const gapTolerance = options.mergeGapTolerance ?? 1;
  const clusters = [];

  for (const line of rulingLines) {
    const cluster = clusters.find((item) =>
      canMergeRulingLines(item, line, { coordinateTolerance, gapTolerance })
    );
    if (cluster) {
      mergeRulingLineInto(cluster, line);
      continue;
    }
    clusters.push(cloneRulingLine(line));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
        if (
          canMergeRulingLines(clusters[leftIndex], clusters[rightIndex], {
            coordinateTolerance,
            gapTolerance
          })
        ) {
          mergeRulingLineInto(clusters[leftIndex], clusters[rightIndex]);
          clusters.splice(rightIndex, 1);
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }

  return clusters.map(finalizeMergedRulingLine);
}

export function tokenizeContentStream(streamText) {
  const source = typeof streamText === "string" ? streamText : runtimeBytesToLatin1(streamText);
  const tokens = [];
  let offset = 0;

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (offset >= source.length) {
      break;
    }

    const char = source[offset];
    if (char === "/") {
      const token = readName(source, offset);
      tokens.push(token.value);
      offset = token.offset;
      continue;
    }
    if (char === "(") {
      const token = readLiteralString(source, offset);
      tokens.push(token.value);
      offset = token.offset;
      continue;
    }
    if (char === "<" && source[offset + 1] !== "<") {
      const token = readHexString(source, offset);
      tokens.push(token.value);
      offset = token.offset;
      continue;
    }
    if (char === "<" && source[offset + 1] === "<") {
      const token = readDictionary(source, offset);
      tokens.push(token.value);
      offset = token.offset;
      continue;
    }
    if (char === "[") {
      const token = readArray(source, offset);
      tokens.push(token.value);
      offset = token.offset;
      continue;
    }

    const numberToken = readNumber(source, offset);
    if (numberToken) {
      tokens.push(numberToken.value);
      offset = numberToken.offset;
      continue;
    }

    const word = readWord(source, offset);
    if (word.offset === offset) {
      offset += 1;
      continue;
    }
    tokens.push(word.value);
    offset = word.offset;
  }

  return tokens;
}

function executePathOperator(operator, context) {
  const { operands, state } = context;

  if (operator === "q") {
    context.stack.push(clonePathGraphicsState(state));
    return;
  }
  if (operator === "Q") {
    const restored = context.stack.pop();
    if (restored) {
      const markedContent = state.markedContent;
      state.ctm = restored.ctm;
      state.lineWidth = restored.lineWidth;
      state.markedContent = markedContent;
    }
    return;
  }
  if (operator === "BMC" || operator === "BDC") {
    state.markedContent.push(readMarkedContent(operands, operator, context.options));
    return;
  }
  if (operator === "EMC") {
    state.markedContent.pop();
    return;
  }
  if (operator === "cm") {
    const [a, b, c, d, e, f] = lastNumbers(operands, 6);
    if ([a, b, c, d, e, f].every(Number.isFinite)) {
      state.ctm = multiplyMatrices(state.ctm, [a, b, c, d, e, f]);
    }
    return;
  }
  if (operator === "w") {
    const width = tokenNumber(operands.at(-1));
    if (Number.isFinite(width)) {
      state.lineWidth = width;
    }
    return;
  }
  if (operator === "m") {
    const [x, y] = lastNumbers(operands, 2);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const point = transformPoint(state.ctm, x, y);
      state.currentPoint = point;
      state.subpathStart = point;
    }
    return;
  }
  if (operator === "l") {
    const [x, y] = lastNumbers(operands, 2);
    if (Number.isFinite(x) && Number.isFinite(y) && state.currentPoint) {
      const point = transformPoint(state.ctm, x, y);
      state.segments.push({
        from: state.currentPoint,
        to: point,
        width: state.lineWidth
      });
      state.currentPoint = point;
    }
    return;
  }
  if (operator === "h") {
    closeCurrentSubpath(state);
    return;
  }
  if (operator === "re") {
    const [x, y, width, height] = lastNumbers(operands, 4);
    if ([x, y, width, height].every(Number.isFinite)) {
      appendRectanglePath(state, x, y, width, height);
    }
    return;
  }
  if (operator === "S" || operator === "B" || operator === "B*") {
    emitRulingSegments(context);
    clearCurrentPath(state);
    return;
  }
  if (operator === "s" || operator === "b" || operator === "b*") {
    closeCurrentSubpath(state);
    emitRulingSegments(context);
    clearCurrentPath(state);
    return;
  }
  if (operator === "n" || operator === "f" || operator === "F" || operator === "f*") {
    clearCurrentPath(state);
  }
}

function emitRulingSegments(context) {
  const structure = currentStructureSignal(context.state);
  for (const segment of context.state.segments) {
    const rulingLine = normalizeRulingSegment(segment, context.options, structure);
    if (rulingLine) {
      context.lines.push(rulingLine);
    }
  }
}

function normalizeRulingSegment(segment, options, structure = null) {
  const axisTolerance = options.axisTolerance ?? 0.5;
  const minLength = options.minLength ?? 2;
  const dx = Math.abs(segment.to.x - segment.from.x);
  const dy = Math.abs(segment.to.y - segment.from.y);

  if (dy <= axisTolerance && dx >= minLength) {
    const x1 = Math.min(segment.from.x, segment.to.x);
    const x2 = Math.max(segment.from.x, segment.to.x);
    const y = (segment.from.y + segment.to.y) / 2;
    return createRulingLine("horizontal", x1, y, x2, y, segment, options, structure);
  }

  if (dx <= axisTolerance && dy >= minLength) {
    const x = (segment.from.x + segment.to.x) / 2;
    const y1 = Math.min(segment.from.y, segment.to.y);
    const y2 = Math.max(segment.from.y, segment.to.y);
    return createRulingLine("vertical", x, y1, x, y2, segment, options, structure);
  }

  return null;
}

function createRulingLine(orientation, x1, y1, x2, y2, segment, options, structure = null) {
  return {
    type: "ruling-line",
    orientation,
    x1: normalizeCoordinate(x1),
    y1: normalizeCoordinate(y1),
    x2: normalizeCoordinate(x2),
    y2: normalizeCoordinate(y2),
    width: normalizeCoordinate(segment.width),
    segmentCount: 1,
    pageIndex: options.pageIndex ?? null,
    streamIndex: options.streamIndex ?? null,
    source: "path-operator",
    ...markedContentProperties(structure)
  };
}

function canMergeRulingLines(left, right, tolerances) {
  if (!sameRulingLineScope(left, right) || left.orientation !== right.orientation) {
    return false;
  }

  const coordinateDelta = Math.abs(lineAxisCoordinate(left) - lineAxisCoordinate(right));
  if (coordinateDelta > tolerances.coordinateTolerance) {
    return false;
  }

  return (
    lineStart(left) <= lineEnd(right) + tolerances.gapTolerance &&
    lineEnd(left) >= lineStart(right) - tolerances.gapTolerance
  );
}

function sameRulingLineScope(left, right) {
  if ((left.pageIndex ?? null) !== (right.pageIndex ?? null)) {
    return false;
  }
  if ((left.source ?? null) !== (right.source ?? null)) {
    return false;
  }
  if (left.pageIndex == null && (left.streamIndex ?? null) !== (right.streamIndex ?? null)) {
    return false;
  }
  return true;
}

function mergeRulingLineInto(target, line) {
  const targetCount = target.segmentCount ?? 1;
  const lineCount = line.segmentCount ?? 1;
  const totalCount = targetCount + lineCount;
  const coordinate =
    (lineAxisCoordinate(target) * targetCount + lineAxisCoordinate(line) * lineCount) /
    totalCount;
  const start = Math.min(lineStart(target), lineStart(line));
  const end = Math.max(lineEnd(target), lineEnd(line));

  if (target.orientation === "horizontal") {
    target.x1 = normalizeCoordinate(start);
    target.y1 = normalizeCoordinate(coordinate);
    target.x2 = normalizeCoordinate(end);
    target.y2 = normalizeCoordinate(coordinate);
  } else {
    target.x1 = normalizeCoordinate(coordinate);
    target.y1 = normalizeCoordinate(start);
    target.x2 = normalizeCoordinate(coordinate);
    target.y2 = normalizeCoordinate(end);
  }

  target.width = normalizeCoordinate(Math.max(target.width ?? 0, line.width ?? 0));
  target.segmentCount = totalCount;
  if ((target.streamIndex ?? null) !== (line.streamIndex ?? null)) {
    target.streamIndex = null;
  }
}

function cloneRulingLine(line) {
  return {
    ...line,
    segmentCount: line.segmentCount ?? 1
  };
}

function finalizeMergedRulingLine(line) {
  return {
    ...line,
    x1: normalizeCoordinate(line.x1),
    y1: normalizeCoordinate(line.y1),
    x2: normalizeCoordinate(line.x2),
    y2: normalizeCoordinate(line.y2),
    width: normalizeCoordinate(line.width ?? 0)
  };
}

function lineAxisCoordinate(line) {
  return line.orientation === "horizontal" ? (line.y1 + line.y2) / 2 : (line.x1 + line.x2) / 2;
}

function lineStart(line) {
  return line.orientation === "horizontal"
    ? Math.min(line.x1, line.x2)
    : Math.min(line.y1, line.y2);
}

function lineEnd(line) {
  return line.orientation === "horizontal"
    ? Math.max(line.x1, line.x2)
    : Math.max(line.y1, line.y2);
}

function appendRectanglePath(state, x, y, width, height) {
  const bottomLeft = transformPoint(state.ctm, x, y);
  const bottomRight = transformPoint(state.ctm, x + width, y);
  const topRight = transformPoint(state.ctm, x + width, y + height);
  const topLeft = transformPoint(state.ctm, x, y + height);
  const points = [bottomLeft, bottomRight, topRight, topLeft];

  for (let index = 0; index < points.length; index += 1) {
    state.segments.push({
      from: points[index],
      to: points[(index + 1) % points.length],
      width: state.lineWidth
    });
  }
  state.currentPoint = bottomLeft;
  state.subpathStart = bottomLeft;
}

function closeCurrentSubpath(state) {
  if (!state.currentPoint || !state.subpathStart) {
    return;
  }
  if (
    state.currentPoint.x !== state.subpathStart.x ||
    state.currentPoint.y !== state.subpathStart.y
  ) {
    state.segments.push({
      from: state.currentPoint,
      to: state.subpathStart,
      width: state.lineWidth
    });
  }
  state.currentPoint = state.subpathStart;
}

function clearCurrentPath(state) {
  state.segments = [];
  state.currentPoint = null;
  state.subpathStart = null;
}

function createInitialPathState() {
  return {
    ctm: [...identityMatrix],
    lineWidth: 1,
    segments: [],
    currentPoint: null,
    subpathStart: null,
    markedContent: []
  };
}

function clonePathGraphicsState(state) {
  return {
    ctm: [...state.ctm],
    lineWidth: state.lineWidth
  };
}

function executeImageOperator(operator, context) {
  const { operands, state } = context;

  if (operator === "q") {
    context.stack.push(cloneImageGraphicsState(state));
    return;
  }
  if (operator === "Q") {
    const restored = context.stack.pop();
    if (restored) {
      const markedContent = state.markedContent;
      state.ctm = restored.ctm;
      state.markedContent = markedContent;
    }
    return;
  }
  if (operator === "BMC" || operator === "BDC") {
    state.markedContent.push(readMarkedContent(operands, operator, context.options));
    return;
  }
  if (operator === "EMC") {
    state.markedContent.pop();
    return;
  }
  if (operator === "cm") {
    const [a, b, c, d, e, f] = lastNumbers(operands, 6);
    if ([a, b, c, d, e, f].every(Number.isFinite)) {
      state.ctm = multiplyMatrices(state.ctm, [a, b, c, d, e, f]);
    }
    return;
  }
  if (operator === "Do") {
    emitImageDraw(context);
  }
}

function emitImageDraw(context) {
  const name = tokenName(context.operands.at(-1));
  const image = name ? context.state.resources?.xobjects?.[name] : null;
  if (!name || image?.subtype !== "Image") {
    return;
  }

  const points = [
    transformPoint(context.state.ctm, 0, 0),
    transformPoint(context.state.ctm, 1, 0),
    transformPoint(context.state.ctm, 1, 1),
    transformPoint(context.state.ctm, 0, 1)
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  const structure = currentStructureSignal(context.state);
  const pixels =
    Number.isFinite(image.width) && Number.isFinite(image.height)
      ? image.width * image.height
      : null;

  context.images.push({
    type: "image-draw",
    name,
    objectNumber: image.objectNumber ?? null,
    x: normalizeCoordinate(x),
    y: normalizeCoordinate(y),
    width: normalizeCoordinate(width),
    height: normalizeCoordinate(height),
    area: normalizeCoordinate(polygonArea(points)),
    imageWidth: image.width ?? null,
    imageHeight: image.height ?? null,
    imagePixels: pixels,
    pageIndex: context.options.pageIndex ?? null,
    streamIndex: context.options.streamIndex ?? null,
    source: "xobject-do",
    ...markedContentProperties(structure)
  });
}

function createInitialImageState(resources = null) {
  return {
    ctm: [...identityMatrix],
    resources,
    markedContent: []
  };
}

function cloneImageGraphicsState(state) {
  return {
    ctm: [...state.ctm]
  };
}

function executeOperator(operator, context) {
  const { operands, state } = context;

  if (operator === "q") {
    context.stack.push(cloneState(state));
    return;
  }
  if (operator === "Q") {
    const restored = context.stack.pop();
    if (restored) {
      const markedContent = state.markedContent;
      Object.assign(state, restored);
      state.markedContent = markedContent;
    }
    return;
  }
  if (operator === "BMC" || operator === "BDC") {
    state.markedContent.push(readMarkedContent(operands, operator, context.options));
    return;
  }
  if (operator === "EMC") {
    state.markedContent.pop();
    return;
  }
  if (operator === "cm") {
    const [a, b, c, d, e, f] = lastNumbers(operands, 6);
    if ([a, b, c, d, e, f].every(Number.isFinite)) {
      state.ctm = multiplyMatrices(state.ctm, [a, b, c, d, e, f]);
    }
    return;
  }
  if (operator === "BT") {
    state.inText = true;
    state.textMatrix = [...identityMatrix];
    state.textLineMatrix = [...identityMatrix];
    context.textObjectId += 1;
    context.lineSerial += 1;
    return;
  }
  if (operator === "ET") {
    state.inText = false;
    return;
  }
  if (operator === "Tf") {
    const fontName = tokenName(operands.at(-2));
    const fontSize = tokenNumber(operands.at(-1));
    if (fontName && Number.isFinite(fontSize)) {
      state.fontName = fontName;
      state.fontSize = fontSize;
      state.font = state.resources?.fonts?.[fontName] ?? null;
    }
    return;
  }
  if (operator === "Tr") {
    const textRenderMode = tokenNumber(operands.at(-1));
    if (Number.isInteger(textRenderMode) && textRenderMode >= 0 && textRenderMode <= 7) {
      state.textRenderMode = textRenderMode;
    }
    return;
  }
  if (operator === "Tc") {
    state.charSpacing = tokenNumber(operands.at(-1)) ?? state.charSpacing;
    return;
  }
  if (operator === "Tw") {
    state.wordSpacing = tokenNumber(operands.at(-1)) ?? state.wordSpacing;
    return;
  }
  if (operator === "Tz") {
    state.horizontalScaling = tokenNumber(operands.at(-1)) ?? state.horizontalScaling;
    return;
  }
  if (operator === "TL") {
    state.leading = tokenNumber(operands.at(-1)) ?? state.leading;
    return;
  }
  if (operator === "Ts") {
    state.textRise = tokenNumber(operands.at(-1)) ?? state.textRise;
    return;
  }
  if (operator === "Td" || operator === "TD") {
    const [tx, ty] = lastNumbers(operands, 2);
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      if (operator === "TD") {
        state.leading = -ty;
      }
      moveTextPosition(state, tx, ty);
      if (isTextLineAdvance(state, tx, ty)) {
        context.lineSerial += 1;
      }
    }
    return;
  }
  if (operator === "Tm") {
    const matrix = lastNumbers(operands, 6);
    if (matrix.every(Number.isFinite)) {
      state.textMatrix = matrix;
      state.textLineMatrix = [...matrix];
      context.lineSerial += 1;
    }
    return;
  }
  if (operator === "T*") {
    moveTextPosition(state, 0, -state.leading);
    context.lineSerial += 1;
    return;
  }
  if (operator === "Tj") {
    emitText(decodeStringToken(operands.at(-1), state.font), context);
    return;
  }
  if (operator === "TJ") {
    const array = operands.at(-1);
    if (array?.type === "array") {
      emitTextArray(array, context);
    }
    return;
  }
  if (operator === "'") {
    moveTextPosition(state, 0, -state.leading);
    context.lineSerial += 1;
    emitText(decodeStringToken(operands.at(-1), state.font), context);
    return;
  }
  if (operator === "\"") {
    const wordSpacing = tokenNumber(operands.at(-3));
    const charSpacing = tokenNumber(operands.at(-2));
    if (Number.isFinite(wordSpacing)) {
      state.wordSpacing = wordSpacing;
    }
    if (Number.isFinite(charSpacing)) {
      state.charSpacing = charSpacing;
    }
    moveTextPosition(state, 0, -state.leading);
    context.lineSerial += 1;
    emitText(decodeStringToken(operands.at(-1), state.font), context);
  }
}

function emitTextArray(array, context) {
  for (let index = 0; index < array.items.length; index += 1) {
    const item = array.items[index];
    const adjustment = tokenNumber(item);
    if (Number.isFinite(adjustment)) {
      const delta = textAdjustmentDelta(context.state, adjustment);
      const nextText = nextDecodedText(array.items, index + 1, context.state.font);
      if (shouldInsertSyntheticWordSpace(context, delta, nextText)) {
        emitSyntheticSpace(context, delta);
      } else {
        advanceTextPositionBy(context.state, delta);
      }
      continue;
    }
    emitText(decodeStringToken(item, context.state.font), context);
  }
}

function emitText(text, context) {
  if (!context.state.inText || !text) {
    return;
  }

  const position = currentTextPosition(context.state);
  const metrics = measureText(context.state, text, position);
  const direction = textDirectionFromContent(context.state, text);
  const confidence = textConfidence(context.state.font);
  const structure = currentStructureSignal(context.state);
  const mergeKey = currentMergeKey(context);
  const lastLine = context.lines.at(-1);
  if (lastLine?.mergeKey === mergeKey) {
    appendInferredInterSpanSpace(lastLine, text, context.state, position, metrics, confidence, structure, direction);
    const span = createSpan(text, context.state, position, metrics, confidence, structure, direction);
    lastLine.text += text;
    lastLine.width = Math.max(lastLine.width, metrics.xEnd - lastLine.x);
    lastLine.height = Math.max(lastLine.height, metrics.height);
    lastLine.direction = mergeTextDirection(lastLine.direction, direction);
    lastLine.spans.push(span);
    lastLine.glyphs.push(...metrics.glyphs);
    mergeLineVisibility(lastLine, span);
    mergeLineStructure(lastLine, structure);
    advanceTextPosition(context.state, text);
    return;
  }

  const span = createSpan(text, context.state, position, metrics, confidence, structure, direction);
  context.lines.push({
    text,
    fontSize: metrics.fontSize,
    fontName: context.state.fontName,
    font: context.state.font,
    x: position.x,
    y: position.y,
    width: metrics.width,
    height: metrics.height,
    spans: [span],
    glyphs: metrics.glyphs,
    pageIndex: context.options.pageIndex ?? null,
    streamIndex: context.options.streamIndex ?? null,
    source: "content-stream",
    confidence,
    direction,
    textRenderMode: context.state.textRenderMode,
    textRenderModes: [context.state.textRenderMode],
    hidden: context.state.textRenderMode === 3,
    hasHiddenText: context.state.textRenderMode === 3,
    markedContentId: structure?.mcid ?? null,
    markedContentTag: structure?.tag ?? null,
    structureRole: structure?.role ?? null,
    structurePath: structure?.path ?? [],
    mergeKey
  });
  advanceTextPosition(context.state, text);
}

function emitSyntheticSpace(context, width) {
  if (!context.state.inText || width <= 0) {
    advanceTextPositionBy(context.state, width);
    return;
  }

  const position = currentTextPosition(context.state);
  const confidence = textConfidence(context.state.font);
  const structure = currentStructureSignal(context.state);
  const direction = textDirectionFromContent(context.state, " ");
  const fontSize = effectiveFontSize(context.state);
  const userWidth = textSpaceHorizontalDistance(context.state, width);
  const metrics = {
    width: userWidth,
    height: fontSize,
    fontSize,
    xEnd: position.x + userWidth,
    glyphs: [
      {
        text: " ",
        codePoint: 32,
        x: position.x,
        y: position.y,
        width: userWidth,
        height: fontSize,
        fontName: context.state.fontName,
        fontSize,
        confidence
      }
    ]
  };
  const mergeKey = currentMergeKey(context);
  const lastLine = context.lines.at(-1);
  if (lastLine?.mergeKey === mergeKey) {
    const span = createSpan(" ", context.state, position, metrics, confidence, structure, direction);
    lastLine.text += " ";
    lastLine.width = Math.max(lastLine.width, metrics.xEnd - lastLine.x);
    lastLine.height = Math.max(lastLine.height, metrics.height);
    lastLine.direction = mergeTextDirection(lastLine.direction, direction);
    lastLine.spans.push(span);
    lastLine.glyphs.push(...metrics.glyphs);
    mergeLineVisibility(lastLine, span);
    mergeLineStructure(lastLine, structure);
  }
  advanceTextPositionBy(context.state, width);
}

function appendInferredInterSpanSpace(line, text, state, position, metrics, confidence, structure, direction) {
  if (!shouldInferInterSpanSpace(line, text, state, position, metrics)) {
    return;
  }

  const width = inferredSpaceWidth(line, position, metrics.fontSize);
  const x = Math.max(line.x, Math.min(position.x, line.x + line.width));
  const spaceMetrics = {
    width,
    height: metrics.fontSize,
    fontSize: metrics.fontSize,
    glyphs: [
      {
        text: " ",
        codePoint: 32,
        x,
        y: position.y,
        width,
        height: metrics.fontSize,
        fontName: state.fontName,
        fontSize: metrics.fontSize,
        confidence
      }
    ]
  };
  const span = createSpan(" ", state, { x, y: position.y }, spaceMetrics, confidence, structure, direction);
  line.text += " ";
  line.width = Math.max(line.width, x + width - line.x);
  line.direction = mergeTextDirection(line.direction, direction);
  line.spans.push(span);
  line.glyphs.push(...spaceMetrics.glyphs);
  mergeLineVisibility(line, span);
  mergeLineStructure(line, structure);
}

function shouldInferInterSpanSpace(line, text, state, position, metrics) {
  const previousText = line.text ?? "";
  if (!previousText || !text || whitespacePattern.test(previousText.at(-1)) || whitespacePattern.test(text.at(0))) {
    return false;
  }
  const gap = position.x - (line.x + line.width);
  const fontSize = metrics.fontSize || 10;
  if (shouldGlueAdjacentTextFragments(previousText, text, gap, fontSize)) {
    return false;
  }

  const minimumGap = hasFontWidthMetrics(state)
    ? inferredInterSpanMinimumGap(previousText, text, fontSize)
    : -fontSize * 0.8;
  return gap >= minimumGap && gap <= fontSize * 2.5;
}

function hasFontWidthMetrics(state) {
  return Number.isInteger(state.font?.firstChar) && Array.isArray(state.font?.widths);
}

function inferredInterSpanMinimumGap(previousText, nextText, fontSize) {
  const previous = trailingWordOrQuoteFragment(previousText);
  const next = leadingWordFragment(nextText);
  if (next && /(?:['\u2019]s|['\u2019"\u201d])$/.test(previous)) {
    return -fontSize * 0.08;
  }
  return fontSize * 0.08;
}

function shouldGlueAdjacentTextFragments(previousText, nextText, gap, fontSize) {
  const previous = trailingWordFragment(previousText);
  const next = leadingWordFragment(nextText);
  if (!previous || !next) {
    return /^[,.;:!?%)\]\}]/.test(nextText);
  }
  if (/^[a-z]$/.test(next) || /^[a-z][,.;:]$/.test(next)) {
    return gap < fontSize * 0.16;
  }
  if (/^[A-Z]{1,3}$/.test(next) && /^[A-Z]{3,}$/.test(previous)) {
    return true;
  }
  return false;
}

function trailingWordFragment(text) {
  return text.match(/[A-Za-z]+$/)?.[0] ?? "";
}

function trailingWordOrQuoteFragment(text) {
  return text.match(/[A-Za-z]+(?:['\u2019]s|['\u2019"\u201d])?$/)?.[0] ?? "";
}

function leadingWordFragment(text) {
  return text.match(/^[A-Za-z]+[,.;:]?/)?.[0] ?? "";
}

function inferredSpaceWidth(line, position, fontSize) {
  const gap = position.x - (line.x + line.width);
  return Math.max(fontSize * 0.25, gap);
}

function shouldInsertSyntheticWordSpace(context, delta, nextText) {
  if (delta < wordGapThreshold(context.state) || !nextText) {
    return false;
  }
  const lastLine = context.lines.at(-1);
  if (!lastLine || lastLine.mergeKey !== currentMergeKey(context) || !lastLine.text) {
    return false;
  }
  return !whitespacePattern.test(lastLine.text.at(-1)) && !whitespacePattern.test(nextText.at(0));
}

function nextDecodedText(items, startIndex, font) {
  for (let index = startIndex; index < items.length; index += 1) {
    const text = decodeStringToken(items[index], font);
    if (text) {
      return text;
    }
  }
  return "";
}

function currentMergeKey(context) {
  return `${context.options.pageIndex ?? ""}:${context.options.streamIndex ?? ""}:${context.textObjectId}:${context.lineSerial}`;
}

function readMarkedContent(operands, operator, options) {
  const tag = tokenName(operands.at(operator === "BDC" ? -2 : -1));
  const properties = operator === "BDC" ? operands.at(-1) : null;
  const mcid = dictionaryNumber(properties, "MCID");
  const structure = Number.isInteger(mcid)
    ? options.structureByMcid?.get(mcid) ?? null
    : null;
  return {
    tag,
    mcid,
    role: structure?.role ?? null,
    path: structure?.path ?? [],
    altText: structure?.altText ?? null,
    actualText: structure?.actualText ?? null,
    language: structure?.language ?? null
  };
}

function markedContentProperties(structure) {
  return {
    ...(Number.isInteger(structure?.mcid) ? { markedContentId: structure.mcid } : {}),
    ...(structure?.tag ? { markedContentTag: structure.tag } : {}),
    ...(structure?.role ? { structureRole: structure.role } : {}),
    ...(structure?.path?.length ? { structurePath: structure.path } : {}),
    ...(structure?.altText ? { altText: structure.altText } : {}),
    ...(structure?.actualText ? { actualText: structure.actualText } : {}),
    ...(structure?.language ? { language: structure.language } : {})
  };
}

function currentStructureSignal(state) {
  for (let index = state.markedContent.length - 1; index >= 0; index -= 1) {
    const item = state.markedContent[index];
    if (item?.role) {
      return item;
    }
  }
  return state.markedContent.at(-1) ?? null;
}

function mergeLineStructure(line, structure) {
  if (!structure || line.structureRole) {
    return;
  }
  line.markedContentId = structure.mcid ?? null;
  line.markedContentTag = structure.tag ?? null;
  line.structureRole = structure.role ?? null;
  line.structurePath = structure.path ?? [];
}

function createInitialState(resources = null) {
  return {
    ctm: [...identityMatrix],
    textMatrix: [...identityMatrix],
    textLineMatrix: [...identityMatrix],
    inText: false,
    fontName: null,
    fontSize: 12,
    font: null,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 100,
    leading: 0,
    textRise: 0,
    textRenderMode: 0,
    markedContent: [],
    resources
  };
}

function cloneState(state) {
  return {
    ...state,
    ctm: [...state.ctm],
    textMatrix: [...state.textMatrix],
    textLineMatrix: [...state.textLineMatrix]
  };
}

function moveTextPosition(state, tx, ty) {
  state.textLineMatrix = multiplyMatrices(state.textLineMatrix, [1, 0, 0, 1, tx, ty]);
  state.textMatrix = [...state.textLineMatrix];
}

function isTextLineAdvance(state, tx, ty) {
  const matrix = multiplyMatrices(state.ctm, state.textLineMatrix);
  const userDx = matrix[0] * tx + matrix[2] * ty;
  const userDy = matrix[1] * tx + matrix[3] * ty;
  if (textDirectionFromState(state) === "vertical") {
    return Math.abs(userDx) > Math.max(0.5, effectiveFontSize(state) * 0.25);
  }
  return Math.abs(userDy) > Math.max(0.5, effectiveFontSize(state) * 0.25);
}

function currentTextPosition(state) {
  const matrix = multiplyMatrices(state.ctm, state.textMatrix);
  return transformPoint(matrix, 0, state.textRise);
}

function textDirectionFromState(state) {
  const matrix = multiplyMatrices(state.ctm, state.textMatrix);
  return Math.abs(matrix[1]) > Math.abs(matrix[0]) * 1.25 ? "vertical" : "ltr";
}

function textDirectionFromContent(state, text) {
  const matrixDirection = textDirectionFromState(state);
  if (matrixDirection === "vertical") {
    return "vertical";
  }
  return scriptTextDirection(text) === "rtl" ? "rtl" : matrixDirection;
}

function scriptTextDirection(text) {
  let rtl = 0;
  let ltr = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (isRtlCodePoint(codePoint)) {
      rtl += 1;
    } else if (isLatinCodePoint(codePoint)) {
      ltr += 1;
    }
  }
  return rtl > ltr ? "rtl" : ltr > 0 ? "ltr" : "unknown";
}

function isRtlCodePoint(codePoint) {
  return (
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  );
}

function isLatinCodePoint(codePoint) {
  return (
    (codePoint >= 0x0041 && codePoint <= 0x005a) ||
    (codePoint >= 0x0061 && codePoint <= 0x007a)
  );
}

function mergeTextDirection(left, right) {
  return left === right ? left : "unknown";
}

function advanceTextPosition(state, text) {
  const width = measureTextWidth(state, text);
  advanceTextPositionBy(state, width);
}

function advanceTextPositionBy(state, width) {
  state.textMatrix = multiplyMatrices(state.textMatrix, [1, 0, 0, 1, width, 0]);
}

function textAdjustmentDelta(state, adjustment) {
  const scale = (state.horizontalScaling || 100) / 100;
  return (-adjustment / 1000) * state.fontSize * scale;
}

function wordGapThreshold(state) {
  const scale = (state.horizontalScaling || 100) / 100;
  return Math.max(state.fontSize * scale * 0.25, 0.5);
}

function measureText(state, text, position) {
  const glyphs = [];
  const confidence = textConfidence(state.font);
  const fontSize = effectiveFontSize(state);
  let cursor = position.x;
  for (const char of text) {
    const width = textSpaceHorizontalDistance(state, measureGlyphWidth(state, char));
    glyphs.push({
      text: char,
      codePoint: char.codePointAt(0),
      x: cursor,
      y: position.y,
      width,
      height: fontSize,
      fontName: state.fontName,
      fontSize,
      confidence
    });
    cursor += width;
  }

  return {
    width: cursor - position.x,
    height: fontSize,
    fontSize,
    xEnd: cursor,
    glyphs
  };
}

function createSpan(text, state, position, metrics, confidence, structure = null, direction = "ltr") {
  return {
    text,
    fontName: state.fontName,
    fontSize: metrics.fontSize,
    x: position.x,
    y: position.y,
    width: metrics.width,
    height: metrics.height,
    confidence,
    direction,
    textRenderMode: state.textRenderMode,
    hidden: state.textRenderMode === 3,
    source: structure?.role ? "tagged-pdf" : "pdf-text",
    markedContentId: structure?.mcid ?? null,
    markedContentTag: structure?.tag ?? null,
    structureRole: structure?.role ?? null,
    structurePath: structure?.path ?? []
  };
}

function mergeLineVisibility(line, span) {
  if (!line.textRenderModes.includes(span.textRenderMode)) {
    line.textRenderModes.push(span.textRenderMode);
  }
  line.textRenderMode = line.textRenderModes.length === 1 ? line.textRenderModes[0] : null;
  line.hidden = line.spans.every((item) => item.hidden === true);
  line.hasHiddenText = line.spans.some((item) => item.hidden === true);
}

function measureTextWidth(state, text) {
  let width = 0;
  for (const char of text) {
    width += measureGlyphWidth(state, char);
  }
  return width;
}

function measureGlyphWidth(state, char) {
  const scale = (state.horizontalScaling || 100) / 100;
  const wordSpacing = char === " " ? state.wordSpacing : 0;
  return (fontGlyphWidth(state, char) + state.charSpacing + wordSpacing) * scale;
}

function fontGlyphWidth(state, char) {
  const firstChar = state.font?.firstChar;
  const widths = state.font?.widths;
  const codePoint = char.codePointAt(0);
  if (Number.isInteger(firstChar) && Array.isArray(widths) && Number.isInteger(codePoint)) {
    const width = widths[codePoint - firstChar];
    if (Number.isFinite(width)) {
      return (width / 1000) * state.fontSize;
    }
  }
  return state.fontSize * 0.5;
}

function effectiveTextMatrix(state) {
  return multiplyMatrices(state.ctm, state.textMatrix);
}

function textSpaceHorizontalDistance(state, width) {
  const matrix = effectiveTextMatrix(state);
  return Math.hypot(matrix[0] * width, matrix[1] * width);
}

function effectiveFontSize(state) {
  const matrix = effectiveTextMatrix(state);
  const verticalScale = Math.hypot(matrix[2], matrix[3]);
  return state.fontSize * (verticalScale || 1);
}

function multiplyMatrices(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}

function transformPoint(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5]
  };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function normalizeCoordinate(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function textConfidence(font) {
  if (font?.toUnicode?.entries > 0) {
    return 0.95;
  }
  if (font?.subtype === "Type1" || font?.subtype === "TrueType") {
    return 0.75;
  }
  return 0.6;
}

function lastNumbers(tokens, count) {
  return tokens.slice(-count).map((token) => tokenNumber(token));
}

function tokenNumber(token) {
  return token?.type === "number" ? token.value : null;
}

function tokenName(token) {
  return token?.type === "name" ? token.value : null;
}

function dictionaryNumber(token, key) {
  const value = token?.type === "dict" ? token.entries[key] : null;
  return tokenNumber(value);
}

function decodeStringToken(token, font) {
  return decodePdfStringWithFont(token, font);
}

function readArray(source, startOffset) {
  const items = [];
  let offset = startOffset + 1;

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (source[offset] === "]") {
      return {
        value: {
          type: "array",
          items
        },
        offset: offset + 1
      };
    }

    const item = readValue(source, offset);
    if (!item || item.offset === offset) {
      offset += 1;
      continue;
    }
    items.push(item.value);
    offset = item.offset;
  }

  return {
    value: {
      type: "array",
      items
    },
    offset
  };
}

function readValue(source, offset) {
  const char = source[offset];
  if (char === "/") {
    return readName(source, offset);
  }
  if (char === "(") {
    return readLiteralString(source, offset);
  }
  if (char === "<" && source[offset + 1] !== "<") {
    return readHexString(source, offset);
  }
  if (char === "<" && source[offset + 1] === "<") {
    return readDictionary(source, offset);
  }
  if (char === "[") {
    return readArray(source, offset);
  }
  return readNumber(source, offset) ?? readWord(source, offset);
}

function readDictionary(source, startOffset) {
  const entries = {};
  let offset = startOffset + 2;

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (source[offset] === ">" && source[offset + 1] === ">") {
      return {
        value: {
          type: "dict",
          entries
        },
        offset: offset + 2
      };
    }

    const key = readName(source, offset);
    if (!key || key.offset === offset || key.value.type !== "name") {
      offset += 1;
      continue;
    }
    offset = skipWhitespaceAndComments(source, key.offset);
    const value = readValue(source, offset);
    if (!value || value.offset === offset) {
      offset += 1;
      continue;
    }
    entries[key.value.value] = value.value;
    offset = value.offset;
  }

  return {
    value: {
      type: "dict",
      entries
    },
    offset
  };
}

function readName(source, startOffset) {
  let offset = startOffset + 1;
  let value = "";
  while (offset < source.length) {
    const char = source[offset];
    if (isWhitespace(char) || delimiterChars.has(char)) {
      break;
    }
    if (char === "#" && /^[0-9a-fA-F]{2}$/.test(source.slice(offset + 1, offset + 3))) {
      value += String.fromCharCode(Number.parseInt(source.slice(offset + 1, offset + 3), 16));
      offset += 3;
      continue;
    }
    value += char;
    offset += 1;
  }
  return {
    value: {
      type: "name",
      value
    },
    offset
  };
}

function readLiteralString(source, startOffset) {
  let offset = startOffset + 1;
  let depth = 1;
  const bytes = [];

  while (offset < source.length) {
    const char = source[offset];
    if (char === "\\") {
      const escaped = readEscapedStringCharacter(source, offset);
      for (const byte of escaped.bytes) {
        bytes.push(byte);
      }
      offset = escaped.offset;
      continue;
    }
    if (char === "(") {
      depth += 1;
      bytes.push(char.charCodeAt(0));
      offset += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        const value = bytesToLatin1(bytes);
        return {
          value: {
            type: "string",
            value,
            bytes
          },
          offset: offset + 1
        };
      }
      bytes.push(char.charCodeAt(0));
      offset += 1;
      continue;
    }
    bytes.push(char.charCodeAt(0) & 0xff);
    offset += 1;
  }

  const value = bytesToLatin1(bytes);
  return {
    value: {
      type: "string",
      value,
      bytes
    },
    offset
  };
}

function readEscapedStringCharacter(source, startOffset) {
  const next = source[startOffset + 1];
  if (next === undefined) {
    return {
      bytes: [],
      offset: startOffset + 1
    };
  }
  if (next === "\r" || next === "\n") {
    let offset = startOffset + 2;
    if (next === "\r" && source[offset] === "\n") {
      offset += 1;
    }
    return {
      bytes: [],
      offset
    };
  }
  if (/[0-7]/.test(next)) {
    const octal = source.slice(startOffset + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
    return {
      bytes: [Number.parseInt(octal, 8) & 0xff],
      offset: startOffset + 1 + octal.length
    };
  }

  const escapes = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    "(": "(",
    ")": ")",
    "\\": "\\"
  };
  const value = escapes[next] ?? next;
  return {
    bytes: [value.charCodeAt(0) & 0xff],
    offset: startOffset + 2
  };
}

function readHexString(source, startOffset) {
  let offset = startOffset + 1;
  let hex = "";
  while (offset < source.length) {
    const char = source[offset];
    if (char === ">") {
      offset += 1;
      break;
    }
    if (/[0-9a-fA-F]/.test(char)) {
      hex += char;
    }
    offset += 1;
  }
  if (hex.length % 2 === 1) {
    hex += "0";
  }

  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return {
    value: {
      type: "string",
      value: bytesToLatin1(bytes),
      bytes
    },
    offset
  };
}

function bytesToLatin1(bytes) {
  return runtimeBytesToLatin1(bytes);
}

function readNumber(source, offset) {
  const match = source.slice(offset).match(/^[-+]?(?:\d+\.\d+|\d+|\.\d+)/);
  if (!match) {
    return null;
  }
  return {
    value: {
      type: "number",
      value: Number.parseFloat(match[0])
    },
    offset: offset + match[0].length
  };
}

function readWord(source, startOffset) {
  let offset = startOffset;
  let value = "";
  while (offset < source.length) {
    const char = source[offset];
    if (isWhitespace(char) || delimiterChars.has(char)) {
      break;
    }
    value += char;
    offset += 1;
  }
  return {
    value: {
      type: "word",
      value
    },
    offset
  };
}

function skipWhitespaceAndComments(source, offset) {
  while (offset < source.length) {
    const char = source[offset];
    if (isWhitespace(char)) {
      offset += 1;
      continue;
    }
    if (char === "%") {
      while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") {
        offset += 1;
      }
      continue;
    }
    break;
  }
  return offset;
}

function isWhitespace(char) {
  return char !== undefined && whitespacePattern.test(char);
}
