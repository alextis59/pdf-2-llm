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

export function tokenizeContentStream(streamText) {
  const source = typeof streamText === "string" ? streamText : Buffer.from(streamText).toString("latin1");
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

function executeOperator(operator, context) {
  const { operands, state } = context;

  if (operator === "q") {
    context.stack.push(cloneState(state));
    return;
  }
  if (operator === "Q") {
    const restored = context.stack.pop();
    if (restored) {
      Object.assign(state, restored);
    }
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
      context.lineSerial += 1;
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
    emitText(tokenString(operands.at(-1)), context);
    return;
  }
  if (operator === "TJ") {
    const array = operands.at(-1);
    if (array?.type === "array") {
      emitText(array.items.map((item) => tokenString(item)).join(""), context);
    }
    return;
  }
  if (operator === "'") {
    moveTextPosition(state, 0, -state.leading);
    context.lineSerial += 1;
    emitText(tokenString(operands.at(-1)), context);
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
    emitText(tokenString(operands.at(-1)), context);
  }
}

function emitText(text, context) {
  if (!context.state.inText || !text) {
    return;
  }

  const position = currentTextPosition(context.state);
  const mergeKey = `${context.options.pageIndex ?? ""}:${context.options.streamIndex ?? ""}:${context.textObjectId}:${context.lineSerial}`;
  const lastLine = context.lines.at(-1);
  if (lastLine?.mergeKey === mergeKey) {
    lastLine.text += text;
    advanceTextPosition(context.state, text);
    return;
  }

  context.lines.push({
    text,
    fontSize: context.state.fontSize,
    fontName: context.state.fontName,
    font: context.state.font,
    x: position.x,
    y: position.y,
    pageIndex: context.options.pageIndex ?? null,
    streamIndex: context.options.streamIndex ?? null,
    source: "content-stream",
    confidence: textConfidence(context.state.font),
    mergeKey
  });
  advanceTextPosition(context.state, text);
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

function currentTextPosition(state) {
  const matrix = multiplyMatrices(state.ctm, state.textMatrix);
  return transformPoint(matrix, 0, state.textRise);
}

function advanceTextPosition(state, text) {
  const scale = (state.horizontalScaling || 100) / 100;
  let width = 0;
  for (const char of text) {
    width += state.fontSize * 0.5 + state.charSpacing;
    if (char === " ") {
      width += state.wordSpacing;
    }
  }
  state.textMatrix = multiplyMatrices(state.textMatrix, [1, 0, 0, 1, width * scale, 0]);
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

function textConfidence(font) {
  if (font?.hasToUnicode) {
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

function tokenString(token) {
  return token?.type === "string" ? token.value : "";
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
  if (char === "[") {
    return readArray(source, offset);
  }
  return readNumber(source, offset) ?? readWord(source, offset);
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
  let raw = "";

  while (offset < source.length) {
    const char = source[offset];
    if (char === "\\") {
      const escaped = readEscapedStringCharacter(source, offset);
      raw += escaped.value;
      offset = escaped.offset;
      continue;
    }
    if (char === "(") {
      depth += 1;
      raw += char;
      offset += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: {
            type: "string",
            value: raw
          },
          offset: offset + 1
        };
      }
      raw += char;
      offset += 1;
      continue;
    }
    raw += char;
    offset += 1;
  }

  return {
    value: {
      type: "string",
      value: raw
    },
    offset
  };
}

function readEscapedStringCharacter(source, startOffset) {
  const next = source[startOffset + 1];
  if (next === undefined) {
    return {
      value: "",
      offset: startOffset + 1
    };
  }
  if (next === "\r" || next === "\n") {
    let offset = startOffset + 2;
    if (next === "\r" && source[offset] === "\n") {
      offset += 1;
    }
    return {
      value: "",
      offset
    };
  }
  if (/[0-7]/.test(next)) {
    const octal = source.slice(startOffset + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
    return {
      value: String.fromCharCode(Number.parseInt(octal, 8)),
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
  return {
    value: escapes[next] ?? next,
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

  let value = "";
  for (let index = 0; index < hex.length; index += 2) {
    value += String.fromCharCode(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return {
    value: {
      type: "string",
      value
    },
    offset
  };
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
