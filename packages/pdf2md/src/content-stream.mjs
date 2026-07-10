import { decodePdfGlyphsWithFont } from "./font-encoding.mjs";
import { bytesToLatin1 as runtimeBytesToLatin1 } from "./runtime.mjs";

const whitespacePattern = /\s/;
const delimiterChars = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const identityMatrix = Object.freeze([1, 0, 0, 1, 0, 0]);

export class PdfContentStreamLimitError extends Error {
  constructor(message, { code, limit, actual, extractor, stackType = null } = {}) {
    super(message);
    this.name = "PdfContentStreamLimitError";
    this.code = code;
    this.offset = null;
    this.details = {
      limit,
      actual,
      extractor,
      ...(stackType ? { stackType } : {})
    };
  }
}

export function extractContentStreamTextLines(streamText, options = {}) {
  return extractContentStreamsTextLines(
    [{ text: streamText, streamIndex: options.streamIndex ?? null }],
    options
  );
}

export function extractContentStreamsTextLines(streams, options = {}) {
  const state = createInitialState(
    options.resources,
    options.initialMatrix,
    options.initialTextOrientationMatrix
  );
  const stack = [];
  const operands = [];
  const lines = [];
  const context = createExecutionContext("text", options, {
    lines,
    operands,
    stack,
    state,
    textObjectId: 0,
    lineSerial: 0
  });

  interpretContentStreams(streams, context, executeOperator);

  return lines.map(({ mergeKey, ...line }) => line);
}

export function extractContentStreamRulingLines(streamText, options = {}) {
  return extractContentStreamsRulingLines(
    [{ text: streamText, streamIndex: options.streamIndex ?? null }],
    options
  );
}

export function extractContentStreamsRulingLines(streams, options = {}) {
  const state = createInitialPathState(options.resources, options.initialMatrix);
  const stack = [];
  const operands = [];
  const lines = [];
  const context = createExecutionContext("ruling", options, {
    lines,
    operands,
    stack,
    state
  });

  interpretContentStreams(streams, context, executePathOperator);

  return options.mergeRulingLines === false ? lines : mergeRulingLines(lines, options);
}

export function extractContentStreamImageDraws(streamText, options = {}) {
  return extractContentStreamsImageDraws(
    [{ text: streamText, streamIndex: options.streamIndex ?? null }],
    options
  );
}

export function extractContentStreamsImageDraws(streams, options = {}) {
  const state = createInitialImageState(options.resources, options.initialMatrix);
  const stack = [];
  const operands = [];
  const images = [];
  const context = createExecutionContext("image", options, {
    images,
    operands,
    stack,
    state
  });

  interpretContentStreams(streams, context, executeImageOperator);

  return images;
}

export function extractContentStreamSignals(streamText, options = {}) {
  return extractContentStreamsSignals(
    [{ text: streamText, streamIndex: options.streamIndex ?? null }],
    options
  );
}

export function extractContentStreamsSignals(streams, options = {}) {
  const textOptions = signalExtractorOptions(options, "text");
  const rulingOptions = signalExtractorOptions(options, "ruling");
  const imageOptions = signalExtractorOptions(options, "image");
  const textContext = createExecutionContext("text", textOptions, {
    lines: [],
    operands: [],
    stack: [],
    state: createInitialState(
      options.resources,
      options.initialMatrix,
      options.initialTextOrientationMatrix
    ),
    textObjectId: 0,
    lineSerial: 0
  });
  const rulingContext = createExecutionContext("ruling", rulingOptions, {
    lines: [],
    operands: [],
    stack: [],
    state: createInitialPathState(options.resources, options.initialMatrix)
  });
  const imageContext = createExecutionContext("image", imageOptions, {
    images: [],
    operands: [],
    stack: [],
    state: createInitialImageState(options.resources, options.initialMatrix)
  });

  interpretContentStreamsSignals(streams, [textContext, rulingContext, imageContext]);

  return {
    textLines: textContext.lines.map(({ mergeKey, ...line }) => line),
    rulingLines:
      options.mergeRulingLines === false
        ? rulingContext.lines
        : mergeRulingLines(rulingContext.lines, options),
    imageDraws: imageContext.images
  };
}

function signalExtractorOptions(options, extractor) {
  return {
    ...options,
    contentStreamBudget:
      options.contentStreamBudgets?.[extractor] ?? options.contentStreamBudget
  };
}

export function mergeRulingLines(rulingLines, options = {}) {
  const coordinateTolerance = Number(options.mergeCoordinateTolerance ?? 0.5);
  const gapTolerance = Number(options.mergeGapTolerance ?? 1);
  if (coordinateTolerance < 0 || Number.isNaN(gapTolerance) || gapTolerance === -Infinity) {
    return rulingLines.map((line) => finalizeMergedRulingLine(cloneRulingLine(line)));
  }

  const groups = new Map();
  for (let index = 0; index < rulingLines.length; index += 1) {
    const line = rulingLines[index];
    const key = rulingLineScopeKey(line);
    const group = groups.get(key) ?? [];
    group.push({ index, line });
    groups.set(key, group);
  }

  return [...groups.values()]
    .flatMap((group) =>
      mergeRulingLineGroup(group, { coordinateTolerance, gapTolerance })
    )
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map((cluster) => finalizeMergedRulingLine(cluster.line));
}

function mergeRulingLineGroup(entries, tolerances) {
  const state = {
    activeBuckets: new Map(),
    clusters: [],
    pairHeap: [],
    tolerances
  };

  for (const entry of entries) {
    if (!hasFiniteRulingGeometry(entry.line)) {
      state.clusters.push({
        active: true,
        bucket: null,
        firstIndex: entry.index,
        indexed: false,
        indexStart: null,
        line: cloneRulingLine(entry.line),
        version: 0
      });
      continue;
    }
    const match = queryRulingClusters(state, entry.line)
      .filter((cluster) => canMergeRulingLines(cluster.line, entry.line, tolerances))
      .sort((left, right) => left.firstIndex - right.firstIndex)[0];
    if (match) {
      removeIndexedRulingCluster(state, match);
      mergeRulingLineInto(match.line, entry.line);
      match.version += 1;
      insertIndexedRulingCluster(state, match);
      continue;
    }

    const cluster = {
      active: true,
      bucket: null,
      firstIndex: entry.index,
      indexed: false,
      indexStart: null,
      line: cloneRulingLine(entry.line),
      version: 0
    };
    state.clusters.push(cluster);
    insertIndexedRulingCluster(state, cluster);
  }

  for (const cluster of state.clusters) {
    enqueueBestLaterRulingPair(state, cluster);
  }
  mergeQueuedRulingPairs(state);
  return state.clusters.filter((cluster) => cluster.active);
}

function mergeQueuedRulingPairs(state) {
  while (state.pairHeap.length > 0) {
    const pair = popRulingPairHeap(state.pairHeap);
    if (!pair.left.active) {
      continue;
    }
    if (
      pair.left.version !== pair.leftVersion ||
      !pair.right.active ||
      pair.right.version !== pair.rightVersion
    ) {
      enqueueBestLaterRulingPair(state, pair.left);
      if (pair.right.active) {
        enqueueBestEarlierRulingPair(state, pair.right);
      }
      continue;
    }
    if (!canMergeRulingLines(pair.left.line, pair.right.line, state.tolerances)) {
      enqueueBestLaterRulingPair(state, pair.left);
      continue;
    }

    removeIndexedRulingCluster(state, pair.left);
    removeIndexedRulingCluster(state, pair.right);
    mergeRulingLineInto(pair.left.line, pair.right.line);
    pair.left.version += 1;
    pair.right.active = false;
    pair.right.version += 1;
    insertIndexedRulingCluster(state, pair.left);
    enqueueBestLaterRulingPair(state, pair.left);
    enqueueBestEarlierRulingPair(state, pair.left);
  }
}

function enqueueBestLaterRulingPair(state, left) {
  if (!left.active || !left.indexed) {
    return;
  }
  const right = queryRulingClusters(state, left.line)
    .filter(
      (candidate) =>
        candidate.firstIndex > left.firstIndex &&
        canMergeRulingLines(left.line, candidate.line, state.tolerances)
    )
    .sort((first, second) => first.firstIndex - second.firstIndex)[0];
  if (right) {
    pushRulingPairHeap(state.pairHeap, createRulingPair(left, right));
  }
}

function enqueueBestEarlierRulingPair(state, right) {
  if (!right.active || !right.indexed) {
    return;
  }
  const left = queryRulingClusters(state, right.line)
    .filter(
      (candidate) =>
        candidate.firstIndex < right.firstIndex &&
        canMergeRulingLines(candidate.line, right.line, state.tolerances)
    )
    .sort((first, second) => first.firstIndex - second.firstIndex)[0];
  if (left) {
    pushRulingPairHeap(state.pairHeap, createRulingPair(left, right));
  }
}

function createRulingPair(left, right) {
  return {
    left,
    leftVersion: left.version,
    right,
    rightVersion: right.version
  };
}

function queryRulingClusters(state, line) {
  if (!hasFiniteRulingGeometry(line)) {
    return [];
  }
  const matches = [];
  const queryStart = lineStart(line) - state.tolerances.gapTolerance;
  const queryEnd = lineEnd(line) + state.tolerances.gapTolerance;
  for (const bucket of neighboringRulingBuckets(line, state.tolerances.coordinateTolerance)) {
    const root = state.activeBuckets.get(bucket);
    if (root) {
      queryRulingIntervalTree(root, queryStart, queryEnd, matches);
    }
  }
  return matches;
}

function insertIndexedRulingCluster(state, cluster) {
  cluster.bucket = rulingCoordinateBucket(cluster.line, state.tolerances.coordinateTolerance);
  cluster.indexStart = lineStart(cluster.line);
  const node = createRulingIntervalNode(cluster);
  state.activeBuckets.set(
    cluster.bucket,
    insertRulingIntervalNode(state.activeBuckets.get(cluster.bucket) ?? null, node)
  );
  cluster.indexed = true;
}

function removeIndexedRulingCluster(state, cluster) {
  if (!cluster.indexed) {
    return;
  }
  const root = removeRulingIntervalNode(
    state.activeBuckets.get(cluster.bucket) ?? null,
    cluster.indexStart,
    cluster.firstIndex
  );
  if (root) {
    state.activeBuckets.set(cluster.bucket, root);
  } else {
    state.activeBuckets.delete(cluster.bucket);
  }
  cluster.indexed = false;
}

function hasFiniteRulingGeometry(line) {
  return (
    Number.isFinite(lineAxisCoordinate(line)) &&
    Number.isFinite(lineStart(line)) &&
    Number.isFinite(lineEnd(line))
  );
}

function createRulingIntervalNode(cluster) {
  return updateRulingIntervalNode({
    cluster,
    end: lineEnd(cluster.line),
    left: null,
    maxEnd: lineEnd(cluster.line),
    priority: rulingIntervalPriority(cluster.firstIndex),
    right: null,
    start: cluster.indexStart
  });
}

function insertRulingIntervalNode(root, node) {
  if (!root) {
    return node;
  }
  if (node.priority < root.priority) {
    const [left, right] = splitRulingIntervalTree(root, node.start, node.cluster.firstIndex);
    node.left = left;
    node.right = right;
    return updateRulingIntervalNode(node);
  }
  if (
    compareRulingIntervalKeys(
      node.start,
      node.cluster.firstIndex,
      root.start,
      root.cluster.firstIndex
    ) < 0
  ) {
    root.left = insertRulingIntervalNode(root.left, node);
  } else {
    root.right = insertRulingIntervalNode(root.right, node);
  }
  return updateRulingIntervalNode(root);
}

function removeRulingIntervalNode(root, start, firstIndex) {
  if (!root) {
    return null;
  }
  const comparison = compareRulingIntervalKeys(
    start,
    firstIndex,
    root.start,
    root.cluster.firstIndex
  );
  if (comparison === 0) {
    return mergeRulingIntervalTrees(root.left, root.right);
  }
  if (comparison < 0) {
    root.left = removeRulingIntervalNode(root.left, start, firstIndex);
  } else {
    root.right = removeRulingIntervalNode(root.right, start, firstIndex);
  }
  return updateRulingIntervalNode(root);
}

function splitRulingIntervalTree(root, start, firstIndex) {
  if (!root) {
    return [null, null];
  }
  if (
    compareRulingIntervalKeys(root.start, root.cluster.firstIndex, start, firstIndex) < 0
  ) {
    const [left, right] = splitRulingIntervalTree(root.right, start, firstIndex);
    root.right = left;
    return [updateRulingIntervalNode(root), right];
  }
  const [left, right] = splitRulingIntervalTree(root.left, start, firstIndex);
  root.left = right;
  return [left, updateRulingIntervalNode(root)];
}

function mergeRulingIntervalTrees(left, right) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (left.priority < right.priority) {
    left.right = mergeRulingIntervalTrees(left.right, right);
    return updateRulingIntervalNode(left);
  }
  right.left = mergeRulingIntervalTrees(left, right.left);
  return updateRulingIntervalNode(right);
}

function queryRulingIntervalTree(root, queryStart, queryEnd, matches) {
  if (!root || root.maxEnd < queryStart) {
    return;
  }
  queryRulingIntervalTree(root.left, queryStart, queryEnd, matches);
  if (root.start <= queryEnd && root.end >= queryStart && root.cluster.active) {
    matches.push(root.cluster);
  }
  if (root.start <= queryEnd) {
    queryRulingIntervalTree(root.right, queryStart, queryEnd, matches);
  }
}

function updateRulingIntervalNode(node) {
  node.maxEnd = Math.max(
    node.end,
    node.left?.maxEnd ?? Number.NEGATIVE_INFINITY,
    node.right?.maxEnd ?? Number.NEGATIVE_INFINITY
  );
  return node;
}

function compareRulingIntervalKeys(leftStart, leftIndex, rightStart, rightIndex) {
  return leftStart - rightStart || leftIndex - rightIndex;
}

function rulingIntervalPriority(firstIndex) {
  let value = (firstIndex + 1) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function pushRulingPairHeap(heap, pair) {
  heap.push(pair);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRulingPairs(heap[parent], pair) <= 0) {
      break;
    }
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = pair;
}

function popRulingPairHeap(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length === 0) {
    return first;
  }
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) {
      break;
    }
    const child =
      right < heap.length && compareRulingPairs(heap[right], heap[left]) < 0
        ? right
        : left;
    if (compareRulingPairs(heap[child], last) >= 0) {
      break;
    }
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function compareRulingPairs(left, right) {
  return (
    left.left.firstIndex - right.left.firstIndex ||
    left.right.firstIndex - right.right.firstIndex
  );
}

function rulingLineScopeKey(line) {
  const pageIndex = line.pageIndex ?? null;
  return JSON.stringify([
    pageIndex,
    line.source ?? null,
    line.orientation ?? null,
    pageIndex == null ? line.streamIndex ?? null : null
  ]);
}

function rulingCoordinateBucket(line, coordinateTolerance) {
  const coordinate = lineAxisCoordinate(line);
  if (Number.isFinite(coordinateTolerance) && coordinateTolerance > 0) {
    return Number.isFinite(coordinate)
      ? Math.floor(coordinate / coordinateTolerance)
      : `non-finite:${coordinate}`;
  }
  if (coordinateTolerance === 0) {
    return coordinate;
  }
  return "all-coordinates";
}

function neighboringRulingBuckets(line, coordinateTolerance) {
  const bucket = rulingCoordinateBucket(line, coordinateTolerance);
  return typeof bucket === "number" && coordinateTolerance > 0
    ? [bucket - 1, bucket, bucket + 1]
    : [bucket];
}

export function tokenizeContentStream(streamText, options = {}) {
  const context = createExecutionContext("tokenizer", options, {});
  return [...iterateContentStreamTokens(streamText, context)];
}

function interpretContentStream(streamText, context, execute) {
  for (const token of iterateContentStreamTokens(streamText, context)) {
    if (token.type === "inline-image") {
      consumeContentStreamOperation(context);
      if (context.extractor === "image") {
        emitInlineImageDraw(token, context);
      }
      context.operands.length = 0;
      continue;
    }
    if (token.type !== "word") {
      context.operands.push(token);
      continue;
    }
    consumeContentStreamOperation(context);
    execute(token.value, context);
    context.operands.length = 0;
  }
}

function interpretContentStreams(streams, context, execute) {
  const baseOptions = context.options;
  for (let index = 0; index < streams.length; index += 1) {
    const stream = streams[index];
    context.options = {
      ...baseOptions,
      streamIndex: Object.hasOwn(stream, "streamIndex") ? stream.streamIndex : index
    };
    interpretContentStream(stream.text, context, execute);
  }
  context.options = baseOptions;
}

function interpretContentStreamsSignals(streams, contexts) {
  const baseOptions = contexts.map((context) => context.options);
  try {
    for (let index = 0; index < streams.length; index += 1) {
      const stream = streams[index];
      for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
        contexts[contextIndex].options = {
          ...baseOptions[contextIndex],
          streamIndex: Object.hasOwn(stream, "streamIndex") ? stream.streamIndex : index
        };
      }
      interpretContentStreamSignals(stream.text, contexts);
    }
  } finally {
    for (let index = 0; index < contexts.length; index += 1) {
      contexts[index].options = baseOptions[index];
    }
  }
}

function interpretContentStreamSignals(streamText, contexts) {
  const operands = [];
  const tokenContext = { extractorContexts: contexts };
  for (const token of iterateContentStreamTokens(streamText, tokenContext)) {
    for (const context of contexts) {
      context.operands = operands;
    }
    if (token.type === "inline-image") {
      for (const context of contexts) {
        consumeContentStreamOperation(context);
      }
      emitInlineImageDraw(token, contexts[2]);
      operands.length = 0;
      continue;
    }
    if (token.type !== "word") {
      operands.push(token);
      continue;
    }
    for (const context of contexts) {
      consumeContentStreamOperation(context);
    }
    executeSignalOperator(token.value, contexts);
    operands.length = 0;
  }
}

function executeSignalOperator(operator, contexts) {
  if (operator === "Do") {
    const form = sharedFormXObject(contexts);
    if (form) {
      executeFormXObjectSignals(contexts, form);
      return;
    }
  }
  executeOperator(operator, contexts[0]);
  executePathOperator(operator, contexts[1]);
  executeImageOperator(operator, contexts[2]);
}

function* iterateContentStreamTokens(streamText, context) {
  const source = typeof streamText === "string" ? streamText : runtimeBytesToLatin1(streamText);
  let offset = 0;

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (offset >= source.length) {
      break;
    }

    const char = source[offset];
    if (char === "/") {
      consumeContentStreamToken(context);
      const token = readName(source, offset);
      yield token.value;
      offset = token.offset;
      continue;
    }
    if (char === "(") {
      consumeContentStreamToken(context);
      const token = readLiteralString(source, offset);
      yield token.value;
      offset = token.offset;
      continue;
    }
    if (char === "<" && source[offset + 1] !== "<") {
      consumeContentStreamToken(context);
      const token = readHexString(source, offset);
      yield token.value;
      offset = token.offset;
      continue;
    }
    if (char === "<" && source[offset + 1] === "<") {
      consumeContentStreamToken(context);
      const token = readDictionary(source, offset, context, 1);
      yield token.value;
      offset = token.offset;
      continue;
    }
    if (char === "[") {
      consumeContentStreamToken(context);
      const token = readArray(source, offset, context, 1);
      yield token.value;
      offset = token.offset;
      continue;
    }

    const numberToken = readNumber(source, offset);
    if (numberToken) {
      consumeContentStreamToken(context);
      yield numberToken.value;
      offset = numberToken.offset;
      continue;
    }

    const word = readWord(source, offset);
    if (word.offset === offset) {
      offset += 1;
      continue;
    }
    consumeContentStreamToken(context);
    if (word.value.value === "BI") {
      const inlineImage = readInlineImage(source, word.offset, context);
      yield inlineImage.value;
      offset = inlineImage.offset;
      continue;
    }
    yield word.value;
    offset = word.offset;
  }
}

function createExecutionContext(extractor, options, values) {
  return {
    ...values,
    extractor,
    options,
    budget: options.contentStreamBudget ?? { operations: 0, outputs: 0 },
    limits: options.contentStreamLimits ?? {}
  };
}

function consumeContentStreamOperation(context) {
  consumeContentStreamBudget(
    context,
    "operations",
    1,
    context.limits.maxOperations,
    "pdf.content_stream.operation_limit_exceeded",
    "Content stream operation limit exceeded."
  );
}

function consumeContentStreamToken(context) {
  consumeContentStreamBudget(
    context,
    "tokens",
    1,
    context.limits?.maxOperations,
    "pdf.content_stream.operation_limit_exceeded",
    "Content stream token limit exceeded."
  );
}

function consumeContentStreamOutput(context, amount = 1) {
  consumeContentStreamBudget(
    context,
    "outputs",
    amount,
    context.limits.maxOutputs,
    "pdf.content_stream.output_limit_exceeded",
    "Content stream output limit exceeded."
  );
}

function consumeContentStreamBudget(context, field, amount, configuredLimit, code, message) {
  if (context.extractorContexts) {
    for (const extractorContext of context.extractorContexts) {
      consumeContentStreamBudget(
        extractorContext,
        field,
        amount,
        extractorContext.limits.maxOperations,
        code,
        message
      );
    }
    return;
  }
  const limit = configuredLimit ?? Number.POSITIVE_INFINITY;
  const actual = (context.budget[field] ?? 0) + amount;
  if (actual > limit) {
    throw new PdfContentStreamLimitError(message, {
      code,
      limit,
      actual,
      extractor: context.extractor
    });
  }
  context.budget[field] = actual;
}

function pushGraphicsState(context, state) {
  enforceContentStreamDepth(context, context.stack.length + 1, "graphics");
  context.stack.push(state);
}

function pushMarkedContent(context, item) {
  enforceContentStreamDepth(context, context.state.markedContent.length + 1, "marked-content");
  context.state.markedContent.push(item);
}

function enforceContentStreamDepth(context, actual, stackType) {
  if (context.extractorContexts) {
    for (const extractorContext of context.extractorContexts) {
      enforceContentStreamDepth(extractorContext, actual, stackType);
    }
    return;
  }
  const limit = context.limits.maxDepth ?? Number.POSITIVE_INFINITY;
  if (actual > limit) {
    throw new PdfContentStreamLimitError("Content stream stack depth limit exceeded.", {
      code: "pdf.content_stream.depth_limit_exceeded",
      limit,
      actual,
      extractor: context.extractor,
      stackType
    });
  }
}

function executePathOperator(operator, context) {
  const { operands, state } = context;

  if (operator === "q") {
    pushGraphicsState(context, clonePathGraphicsState(state));
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
    pushMarkedContent(context, readMarkedContent(operands, operator, context.options));
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
    executeFormXObject(context);
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
      consumeContentStreamOutput(context);
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
    closeCurrentSubpath(context);
    return;
  }
  if (operator === "re") {
    const [x, y, width, height] = lastNumbers(operands, 4);
    if ([x, y, width, height].every(Number.isFinite)) {
      appendRectanglePath(context, x, y, width, height);
    }
    return;
  }
  if (operator === "S" || operator === "B" || operator === "B*") {
    emitRulingSegments(context);
    clearCurrentPath(state);
    return;
  }
  if (operator === "s" || operator === "b" || operator === "b*") {
    closeCurrentSubpath(context);
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
      consumeContentStreamOutput(context);
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

function appendRectanglePath(context, x, y, width, height) {
  const { state } = context;
  const bottomLeft = transformPoint(state.ctm, x, y);
  const bottomRight = transformPoint(state.ctm, x + width, y);
  const topRight = transformPoint(state.ctm, x + width, y + height);
  const topLeft = transformPoint(state.ctm, x, y + height);
  const points = [bottomLeft, bottomRight, topRight, topLeft];

  consumeContentStreamOutput(context, points.length);
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

function closeCurrentSubpath(context) {
  const { state } = context;
  if (!state.currentPoint || !state.subpathStart) {
    return;
  }
  if (
    state.currentPoint.x !== state.subpathStart.x ||
    state.currentPoint.y !== state.subpathStart.y
  ) {
    consumeContentStreamOutput(context);
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

function createInitialPathState(resources = null, initialMatrix = identityMatrix) {
  return {
    ctm: normalizedInitialMatrix(initialMatrix),
    lineWidth: 1,
    segments: [],
    currentPoint: null,
    subpathStart: null,
    resources,
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
    pushGraphicsState(context, cloneImageGraphicsState(state));
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
    pushMarkedContent(context, readMarkedContent(operands, operator, context.options));
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
    if (!executeFormXObject(context)) {
      emitImageDraw(context);
    }
  }
}

function emitImageDraw(context) {
  const name = tokenName(context.operands.at(-1));
  const image = name ? context.state.resources?.xobjects?.[name] : null;
  if (!name || image?.subtype !== "Image") {
    return;
  }
  consumeContentStreamOutput(context);

  const geometry = imageDrawGeometry(context.state.ctm);
  const structure = currentStructureSignal(context.state);
  const pixels =
    Number.isFinite(image.width) && Number.isFinite(image.height)
      ? image.width * image.height
      : null;

  context.images.push({
    type: "image-draw",
    name,
    objectNumber: image.objectNumber ?? null,
    ...geometry,
    imageWidth: image.width ?? null,
    imageHeight: image.height ?? null,
    imagePixels: pixels,
    pageIndex: context.options.pageIndex ?? null,
    streamIndex: context.options.streamIndex ?? null,
    source: "xobject-do",
    ...markedContentProperties(structure)
  });
}

function executeFormXObject(context) {
  const form = formXObjectForContext(context);
  if (!form) {
    return false;
  }

  const formStack = context.formStack ?? (context.formStack = []);
  const actualDepth = formStack.length + 1;
  enforceContentStreamDepth(context, actualDepth, "form-xobject");
  const identity = Number.isInteger(form.objectNumber)
    ? `${form.objectNumber}:${form.generationNumber ?? 0}`
    : form;
  if (formStack.includes(identity)) {
    throw new PdfContentStreamLimitError("Content stream Form XObject cycle detected.", {
      code: "pdf.content_stream.form_cycle_detected",
      limit: context.limits.maxDepth ?? 100,
      actual: actualDepth,
      extractor: context.extractor,
      stackType: "form-xobject"
    });
  }

  const parentState = context.state;
  const parentOperands = context.operands;
  const parentGraphicsStack = context.stack;
  formStack.push(identity);
  context.state = createFormExecutionState(context.extractor, parentState, form);
  context.operands = [];
  context.stack = [];
  try {
    interpretContentStream(form.stream.text, context, formOperatorExecutor(context.extractor));
  } finally {
    context.state = parentState;
    context.operands = parentOperands;
    context.stack = parentGraphicsStack;
    formStack.pop();
  }
  return true;
}

function formXObjectForContext(context) {
  const name = tokenName(context.operands.at(-1));
  const form = name ? context.state.resources?.xobjects?.[name] : null;
  return form?.subtype === "Form" && form.stream ? form : null;
}

function sharedFormXObject(contexts) {
  const form = formXObjectForContext(contexts[0]);
  return form && contexts.every((context) => formXObjectForContext(context) === form)
    ? form
    : null;
}

function executeFormXObjectSignals(contexts, form) {
  const frames = contexts.map((context) => {
    const formStack = context.formStack ?? (context.formStack = []);
    const actualDepth = formStack.length + 1;
    enforceContentStreamDepth(context, actualDepth, "form-xobject");
    const identity = Number.isInteger(form.objectNumber)
      ? `${form.objectNumber}:${form.generationNumber ?? 0}`
      : form;
    if (formStack.includes(identity)) {
      throw new PdfContentStreamLimitError("Content stream Form XObject cycle detected.", {
        code: "pdf.content_stream.form_cycle_detected",
        limit: context.limits.maxDepth ?? 100,
        actual: actualDepth,
        extractor: context.extractor,
        stackType: "form-xobject"
      });
    }
    return {
      context,
      formStack,
      identity,
      parentGraphicsStack: context.stack,
      parentOperands: context.operands,
      parentState: context.state
    };
  });

  try {
    for (const frame of frames) {
      frame.formStack.push(frame.identity);
      frame.context.state = createFormExecutionState(
        frame.context.extractor,
        frame.parentState,
        form
      );
      frame.context.operands = [];
      frame.context.stack = [];
    }
    interpretContentStreamSignals(form.stream.text, contexts);
  } finally {
    for (const frame of frames) {
      frame.context.state = frame.parentState;
      frame.context.operands = frame.parentOperands;
      frame.context.stack = frame.parentGraphicsStack;
      frame.formStack.pop();
    }
  }
}

function createFormExecutionState(extractor, parentState, form) {
  const matrix = validMatrix(form.matrix) ? form.matrix : identityMatrix;
  const ctm = multiplyMatrices(parentState.ctm, matrix);
  const resources = form.resources ?? parentState.resources;
  const markedContent = [...parentState.markedContent];
  if (extractor === "text") {
    return {
      ...cloneState(parentState),
      ctm,
      textOrientationCtm: multiplyMatrices(parentState.textOrientationCtm, matrix),
      resources,
      markedContent
    };
  }
  if (extractor === "ruling") {
    return {
      ctm,
      lineWidth: parentState.lineWidth,
      segments: [],
      currentPoint: null,
      subpathStart: null,
      resources,
      markedContent
    };
  }
  return {
    ctm,
    resources,
    markedContent
  };
}

function formOperatorExecutor(extractor) {
  if (extractor === "text") {
    return executeOperator;
  }
  if (extractor === "ruling") {
    return executePathOperator;
  }
  return executeImageOperator;
}

function validMatrix(value) {
  return Array.isArray(value) && value.length === 6 && value.every(Number.isFinite);
}

function emitInlineImageDraw(token, context) {
  if (!token.complete) {
    return;
  }
  consumeContentStreamOutput(context);

  const geometry = imageDrawGeometry(context.state.ctm);
  const imageWidth = inlineImageNumber(token.entries, "Width", "W");
  const imageHeight = inlineImageNumber(token.entries, "Height", "H");
  const imagePixels =
    Number.isFinite(imageWidth) && Number.isFinite(imageHeight)
      ? imageWidth * imageHeight
      : null;
  const structure = currentStructureSignal(context.state);

  context.images.push({
    type: "image-draw",
    name: "inline-image",
    objectNumber: null,
    ...geometry,
    imageWidth,
    imageHeight,
    imagePixels,
    pageIndex: context.options.pageIndex ?? null,
    streamIndex: context.options.streamIndex ?? null,
    source: "inline-image",
    ...markedContentProperties(structure)
  });
}

function imageDrawGeometry(ctm) {
  const points = [
    transformPoint(ctm, 0, 0),
    transformPoint(ctm, 1, 0),
    transformPoint(ctm, 1, 1),
    transformPoint(ctm, 0, 1)
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: normalizeCoordinate(x),
    y: normalizeCoordinate(y),
    width: normalizeCoordinate(Math.max(...xs) - x),
    height: normalizeCoordinate(Math.max(...ys) - y),
    area: normalizeCoordinate(polygonArea(points))
  };
}

function createInitialImageState(resources = null, initialMatrix = identityMatrix) {
  return {
    ctm: normalizedInitialMatrix(initialMatrix),
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
    pushGraphicsState(context, cloneState(state));
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
    pushMarkedContent(context, readMarkedContent(operands, operator, context.options));
    return;
  }
  if (operator === "EMC") {
    state.markedContent.pop();
    return;
  }
  if (operator === "cm") {
    const [a, b, c, d, e, f] = lastNumbers(operands, 6);
    if ([a, b, c, d, e, f].every(Number.isFinite)) {
      const matrix = [a, b, c, d, e, f];
      state.ctm = multiplyMatrices(state.ctm, matrix);
      state.textOrientationCtm = multiplyMatrices(state.textOrientationCtm, matrix);
    }
    return;
  }
  if (operator === "Do") {
    executeFormXObject(context);
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
    emitText(decodeGlyphToken(operands.at(-1), state.font), context);
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
    emitText(decodeGlyphToken(operands.at(-1), state.font), context);
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
    emitText(decodeGlyphToken(operands.at(-1), state.font), context);
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
    emitText(decodeGlyphToken(item, context.state.font), context);
  }
}

function emitText(decodedGlyphs, context) {
  if (!context.state.inText || decodedGlyphs.length === 0) {
    return;
  }

  const text = decodedGlyphText(decodedGlyphs);
  if (!text) {
    advanceTextPosition(context.state, decodedGlyphs);
    return;
  }
  consumeContentStreamOutput(context, text.length);
  const position = currentTextPosition(context.state);
  const metrics = measureText(context.state, decodedGlyphs, position);
  const direction = textDirectionFromContent(context.state, text);
  const confidence = textConfidence(context.state.font);
  const structure = currentStructureSignal(context.state);
  const mergeKey = currentMergeKey(context);
  const lastLine = context.lines.at(-1);
  if (canAppendTextToLine(lastLine, context, metrics, direction, mergeKey)) {
    appendInferredInterSpanSpace(
      context,
      lastLine,
      text,
      context.state,
      position,
      metrics,
      confidence,
      structure,
      direction
    );
    const span = createSpan(text, context.state, position, metrics, confidence, structure, direction);
    lastLine.text += text;
    mergeLineBounds(lastLine, metrics);
    lastLine.direction = mergeTextDirection(lastLine.direction, direction);
    lastLine.spans.push(span);
    lastLine.glyphs.push(...metrics.glyphs);
    mergeLineVisibility(lastLine, span);
    mergeLineStructure(lastLine, structure);
    mergeTextLineStreamIndex(lastLine, context.options.streamIndex ?? null);
    advanceTextPosition(context.state, decodedGlyphs);
    return;
  }

  const span = createSpan(text, context.state, position, metrics, confidence, structure, direction);
  context.lines.push({
    text,
    fontSize: metrics.fontSize,
    fontName: context.state.fontName,
    font: context.state.font,
    x: metrics.x,
    y: metrics.y,
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
  advanceTextPosition(context.state, decodedGlyphs);
}

function canAppendTextToLine(line, context, metrics, direction, mergeKey) {
  if (!line) {
    return false;
  }
  if (line.mergeKey === mergeKey) {
    return true;
  }
  if (
    line.pageIndex !== (context.options.pageIndex ?? null) ||
    (line.pageIndex == null &&
      line.streamIndex !== (context.options.streamIndex ?? null)) ||
    line.fontName !== context.state.fontName ||
    line.direction !== direction ||
    direction === "vertical"
  ) {
    return false;
  }
  const fontSize = metrics.fontSize || line.fontSize || 10;
  const gap = metrics.x - (line.x + line.width);
  return (
    Math.abs(metrics.y - line.y) <= Math.max(0.5, fontSize * 0.05) &&
    gap >= -fontSize * 0.1 &&
    gap <= fontSize * 0.1
  );
}

function mergeTextLineStreamIndex(line, streamIndex) {
  if (line.streamIndex !== streamIndex) {
    line.streamIndex = null;
  }
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
  const metrics = measureText(context.state, [syntheticDecodedGlyph(" ")], position, width);
  const mergeKey = currentMergeKey(context);
  const lastLine = context.lines.at(-1);
  if (lastLine?.mergeKey === mergeKey) {
    consumeContentStreamOutput(context);
    const span = createSpan(" ", context.state, position, metrics, confidence, structure, direction);
    lastLine.text += " ";
    mergeLineBounds(lastLine, metrics);
    lastLine.direction = mergeTextDirection(lastLine.direction, direction);
    lastLine.spans.push(span);
    lastLine.glyphs.push(...metrics.glyphs);
    mergeLineVisibility(lastLine, span);
    mergeLineStructure(lastLine, structure);
  }
  advanceTextPositionBy(context.state, width);
}

function mergeLineBounds(line, bounds) {
  const minX = Math.min(line.x, bounds.x);
  const minY = Math.min(line.y, bounds.y);
  const maxX = Math.max(line.x + line.width, bounds.x + bounds.width);
  const maxY = Math.max(line.y + line.height, bounds.y + bounds.height);
  line.x = minX;
  line.y = minY;
  line.width = maxX - minX;
  line.height = maxY - minY;
}

function appendInferredInterSpanSpace(
  context,
  line,
  text,
  state,
  position,
  metrics,
  confidence,
  structure,
  direction
) {
  if (!shouldInferInterSpanSpace(line, text, state, position, metrics)) {
    return;
  }

  consumeContentStreamOutput(context);
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
  if (/[A-Za-z]-$/.test(previousText) && /^[a-z]/.test(nextText) && gap <= 0) {
    return true;
  }
  const previous = trailingWordFragment(previousText);
  const next = leadingWordFragment(nextText);
  if (!previous || !next) {
    return /^[,.;:!?%)\]\}]/.test(nextText);
  }
  if (/(?:['\u2019]s|['\u2019"\u201d])$/.test(previousText)) {
    return false;
  }
  if (gap <= 0) {
    return true;
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
    const text = decodedGlyphText(decodeGlyphToken(items[index], font));
    if (text) {
      return text;
    }
  }
  return "";
}

function currentMergeKey(context) {
  const scope =
    context.options.pageIndex == null
      ? `stream:${context.options.streamIndex ?? ""}`
      : `page:${context.options.pageIndex}`;
  return `${scope}:${context.textObjectId}:${context.lineSerial}`;
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

function createInitialState(
  resources = null,
  initialMatrix = identityMatrix,
  initialTextOrientationMatrix = initialMatrix
) {
  return {
    ctm: normalizedInitialMatrix(initialMatrix),
    textOrientationCtm: normalizedInitialMatrix(initialTextOrientationMatrix),
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

function normalizedInitialMatrix(value) {
  return validMatrix(value) ? [...value] : [...identityMatrix];
}

function cloneState(state) {
  return {
    ...state,
    ctm: [...state.ctm],
    textOrientationCtm: [...state.textOrientationCtm],
    textMatrix: [...state.textMatrix],
    textLineMatrix: [...state.textLineMatrix]
  };
}

function moveTextPosition(state, tx, ty) {
  state.textLineMatrix = multiplyMatrices(state.textLineMatrix, [1, 0, 0, 1, tx, ty]);
  state.textMatrix = [...state.textLineMatrix];
}

function isTextLineAdvance(state, tx, ty) {
  const matrix = multiplyMatrices(state.textOrientationCtm, state.textLineMatrix);
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
  const matrix = multiplyMatrices(state.textOrientationCtm, state.textMatrix);
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

function advanceTextPosition(state, decodedGlyphs) {
  const width = measureTextWidth(state, decodedGlyphs);
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

function measureText(state, decodedGlyphs, position, explicitAdvance = null) {
  const glyphs = [];
  const confidence = textConfidence(state.font);
  const fontSize = effectiveFontSize(state);
  const matrix = effectiveTextMatrix(state);
  let textOffset = 0;
  let bounds = null;
  for (const decodedGlyph of decodedGlyphs) {
    const advance = explicitAdvance ?? measureGlyphWidth(state, decodedGlyph);
    const glyphBounds = transformedTextBounds(matrix, textOffset, advance, state);
    glyphs.push({
      text: decodedGlyph.text,
      codePoint: decodedGlyph.text.codePointAt(0) ?? null,
      ...glyphBounds,
      fontName: state.fontName,
      fontSize,
      confidence
    });
    bounds = bounds ? unionBounds(bounds, glyphBounds) : glyphBounds;
    textOffset += advance;
  }

  const measuredBounds = bounds ?? {
    x: position.x,
    y: position.y,
    width: 0,
    height: fontSize
  };

  return {
    ...measuredBounds,
    fontSize,
    glyphs
  };
}

function transformedTextBounds(matrix, textOffset, advance, state) {
  const yStart = state.textRise;
  const yEnd = state.textRise + state.fontSize;
  const points = [
    transformPoint(matrix, textOffset, yStart),
    transformPoint(matrix, textOffset + advance, yStart),
    transformPoint(matrix, textOffset + advance, yEnd),
    transformPoint(matrix, textOffset, yEnd)
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y
  };
}

function unionBounds(left, right) {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y
  };
}

function createSpan(text, state, position, metrics, confidence, structure = null, direction = "ltr") {
  return {
    text,
    fontName: state.fontName,
    fontSize: metrics.fontSize,
    x: metrics.x ?? position.x,
    y: metrics.y ?? position.y,
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

function measureTextWidth(state, decodedGlyphs) {
  let width = 0;
  for (const decodedGlyph of decodedGlyphs) {
    width += measureGlyphWidth(state, decodedGlyph);
  }
  return width;
}

function measureGlyphWidth(state, decodedGlyph) {
  const scale = (state.horizontalScaling || 100) / 100;
  const wordSpacing = decodedGlyph.sourceCodeHex === "20" ? state.wordSpacing : 0;
  return (
    fontGlyphWidth(state, decodedGlyph.sourceCode) + state.charSpacing + wordSpacing
  ) * scale;
}

function fontGlyphWidth(state, sourceCode) {
  const firstChar = state.font?.firstChar;
  const widths = state.font?.widths;
  if (Number.isInteger(firstChar) && Array.isArray(widths) && Number.isInteger(sourceCode)) {
    const width = widths[sourceCode - firstChar];
    if (Number.isFinite(width)) {
      return (width / 1000) * state.fontSize;
    }
  }
  return state.fontSize * 0.5;
}

function effectiveTextMatrix(state) {
  return multiplyMatrices(state.ctm, state.textMatrix);
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

function decodeGlyphToken(token, font) {
  return decodePdfGlyphsWithFont(token, font);
}

function decodedGlyphText(glyphs) {
  return glyphs.map((glyph) => glyph.text).join("");
}

function syntheticDecodedGlyph(text) {
  return {
    text,
    sourceCode: null,
    sourceCodeHex: null
  };
}

function readInlineImage(source, startOffset, context) {
  const entries = {};
  let offset = startOffset;

  enforceContentStreamDepth(context, 1, "syntax");

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (offset >= source.length) {
      break;
    }
    const marker = readWord(source, offset);
    if (marker.value.value === "ID") {
      const separator = consumeInlineImageDataSeparator(source, marker.offset);
      const dataStart = separator.offset;
      const end = findInlineImageEnd(source, dataStart, entries);
      return {
        value: {
          type: "inline-image",
          entries,
          dataLength: end.dataEnd - dataStart,
          complete: separator.valid && end.complete
        },
        offset: end.offset
      };
    }

    if (source[offset] !== "/") {
      const skipped = readValue(source, offset, context, 1);
      offset = skipped?.offset > offset ? skipped.offset : offset + 1;
      continue;
    }

    consumeContentStreamToken(context);
    const key = readName(source, offset);
    offset = skipWhitespaceAndComments(source, key.offset);
    const value = readValue(source, offset, context, 1);
    if (!value || value.offset === offset) {
      offset += 1;
      continue;
    }
    entries[key.value.value] = value.value;
    offset = value.offset;
  }

  return {
    value: {
      type: "inline-image",
      entries,
      dataLength: 0,
      complete: false
    },
    offset: source.length
  };
}

function consumeInlineImageDataSeparator(source, offset) {
  if (source[offset] === "\r" && source[offset + 1] === "\n") {
    return { offset: offset + 2, valid: true };
  }
  if (isWhitespace(source[offset])) {
    return { offset: offset + 1, valid: true };
  }
  return { offset, valid: false };
}

function findInlineImageEnd(source, dataStart, entries) {
  const expectedLength = inlineImageExpectedDataLength(entries);
  if (expectedLength !== null && expectedLength <= source.length - dataStart) {
    const exactEnd = inlineImageEndAtExpectedLength(source, dataStart + expectedLength);
    if (exactEnd) {
      return exactEnd;
    }
  }

  let markerOffset = source.indexOf("EI", dataStart);
  while (markerOffset >= 0) {
    if (
      isWhitespace(source[markerOffset - 1]) &&
      isInlineImageOperatorBoundary(source[markerOffset + 2])
    ) {
      return {
        dataEnd: Math.max(dataStart, markerOffset - 1),
        offset: markerOffset + 2,
        complete: true
      };
    }
    markerOffset = source.indexOf("EI", markerOffset + 2);
  }

  return {
    dataEnd: source.length,
    offset: source.length,
    complete: false
  };
}

function inlineImageEndAtExpectedLength(source, dataEnd) {
  if (!isWhitespace(source[dataEnd])) {
    return null;
  }
  let markerOffset = dataEnd;
  while (isWhitespace(source[markerOffset])) {
    markerOffset += 1;
  }
  if (
    source.slice(markerOffset, markerOffset + 2) !== "EI" ||
    !isInlineImageOperatorBoundary(source[markerOffset + 2])
  ) {
    return null;
  }
  return {
    dataEnd,
    offset: markerOffset + 2,
    complete: true
  };
}

function isInlineImageOperatorBoundary(char) {
  return char === undefined || isWhitespace(char) || delimiterChars.has(char);
}

function inlineImageExpectedDataLength(entries) {
  if (inlineImageEntry(entries, "Filter", "F") !== undefined) {
    return null;
  }
  const width = inlineImageNumber(entries, "Width", "W");
  const height = inlineImageNumber(entries, "Height", "H");
  const imageMask = tokenBoolean(inlineImageEntry(entries, "ImageMask", "IM"));
  const bitsPerComponent = imageMask
    ? 1
    : inlineImageNumber(entries, "BitsPerComponent", "BPC");
  const components = imageMask ? 1 : inlineImageColorComponents(entries);
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0 ||
    !Number.isInteger(bitsPerComponent) ||
    bitsPerComponent <= 0 ||
    !Number.isInteger(components) ||
    components <= 0
  ) {
    return null;
  }
  const rowBits = width * components * bitsPerComponent;
  const rowBytes = Math.ceil(rowBits / 8);
  const totalBytes = rowBytes * height;
  return Number.isSafeInteger(totalBytes) ? totalBytes : null;
}

function inlineImageColorComponents(entries) {
  const colorSpace = inlineImageEntry(entries, "ColorSpace", "CS");
  const name =
    tokenName(colorSpace) ??
    (colorSpace?.type === "array" ? tokenName(colorSpace.items[0]) : null);
  if (name === "DeviceGray" || name === "G" || name === "Indexed" || name === "I") {
    return 1;
  }
  if (name === "DeviceRGB" || name === "RGB") {
    return 3;
  }
  if (name === "DeviceCMYK" || name === "CMYK") {
    return 4;
  }
  return null;
}

function inlineImageNumber(entries, longName, abbreviation) {
  const value = tokenNumber(inlineImageEntry(entries, longName, abbreviation));
  return Number.isFinite(value) ? value : null;
}

function inlineImageEntry(entries, longName, abbreviation) {
  return entries[longName] ?? entries[abbreviation];
}

function tokenBoolean(token) {
  return token?.type === "word" && token.value === "true";
}

function readArray(source, startOffset, context, depth) {
  const items = [];
  let offset = startOffset + 1;

  enforceContentStreamDepth(context, depth, "syntax");

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (offset >= source.length) {
      break;
    }
    if (source[offset] === "]") {
      return {
        value: {
          type: "array",
          items
        },
        offset: offset + 1
      };
    }

    const item = readValue(source, offset, context, depth);
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

function readValue(source, offset, context, depth) {
  consumeContentStreamToken(context);
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
    return readDictionary(source, offset, context, depth + 1);
  }
  if (char === "[") {
    return readArray(source, offset, context, depth + 1);
  }
  return readNumber(source, offset) ?? readWord(source, offset);
}

function readDictionary(source, startOffset, context, depth) {
  const entries = {};
  let offset = startOffset + 2;

  enforceContentStreamDepth(context, depth, "syntax");

  while (offset < source.length) {
    offset = skipWhitespaceAndComments(source, offset);
    if (offset >= source.length) {
      break;
    }
    if (source[offset] === ">" && source[offset + 1] === ">") {
      return {
        value: {
          type: "dict",
          entries
        },
        offset: offset + 2
      };
    }

    consumeContentStreamToken(context);
    const key = readName(source, offset);
    if (!key || key.offset === offset || key.value.type !== "name") {
      offset += 1;
      continue;
    }
    offset = skipWhitespaceAndComments(source, key.offset);
    const value = readValue(source, offset, context, depth);
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
