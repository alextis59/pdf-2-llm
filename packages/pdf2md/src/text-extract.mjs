export function extractTextLines(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  const lines = [];
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;

  for (const streamMatch of source.matchAll(streamPattern)) {
    const stream = streamMatch[1];
    for (const textBlockMatch of stream.matchAll(/BT([\s\S]*?)ET/g)) {
      const block = textBlockMatch[1];
      const fontSize = readFontSize(block);
      const text = readShownText(block).trim();
      if (text.length > 0) {
        lines.push({
          text,
          fontSize
        });
      }
    }
  }

  return lines;
}

export function linesToMarkdown(lines) {
  const blocks = [];
  let previousWasList = false;

  for (const line of lines) {
    const text = normalizeWhitespace(line.text);
    if (text.length === 0) {
      continue;
    }

    if (line.fontSize >= 20) {
      previousWasList = false;
      blocks.push(`# ${text}`);
      continue;
    }

    if (line.fontSize >= 15) {
      previousWasList = false;
      blocks.push(`## ${text}`);
      continue;
    }

    if (/^[-*]\s+/.test(text)) {
      const item = text.replace(/^[-*]\s+/, "- ");
      if (previousWasList) {
        blocks[blocks.length - 1] = `${blocks[blocks.length - 1]}\n${item}`;
      } else {
        blocks.push(item);
      }
      previousWasList = true;
      continue;
    }

    previousWasList = false;
    blocks.push(text);
  }

  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

function readFontSize(block) {
  const matches = [...block.matchAll(/\/[A-Za-z0-9]+\s+([-+]?\d*\.?\d+)\s+Tf/g)];
  if (matches.length === 0) {
    return 12;
  }
  return Number.parseFloat(matches[matches.length - 1][1]);
}

function readShownText(block) {
  const parts = [];

  for (const match of block.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    parts.push(decodePdfString(match[1]));
  }

  for (const match of block.matchAll(/\[((?:.|\n)*?)\]\s*TJ/g)) {
    for (const stringMatch of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) {
      parts.push(decodePdfString(stringMatch[1]));
    }
  }

  for (const match of block.matchAll(/\(((?:\\.|[^\\)])*)\)\s*'/g)) {
    parts.push(decodePdfString(match[1]));
  }

  for (const match of block.matchAll(/[-+]?\d*\.?\d+\s+[-+]?\d*\.?\d+\s+\(((?:\\.|[^\\)])*)\)\s*"/g)) {
    parts.push(decodePdfString(match[1]));
  }

  return parts.join("");
}

function decodePdfString(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      output += character;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      continue;
    }

    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      output += String.fromCharCode(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
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
    output += escapes[next] ?? next;
    index += 1;
  }
  return output;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}
