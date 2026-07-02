export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function randomInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomBool(rng) {
  return rng() >= 0.5;
}

export function randomBytes(rng, length) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = randomInt(rng, 0, 255);
  }
  return bytes;
}

export function randomAscii(rng, length, alphabet) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[randomInt(rng, 0, alphabet.length - 1)];
  }
  return value;
}

export function randomPdfValue(rng, depth = 0) {
  const choices =
    depth > 2
      ? ["number", "bool", "null", "name", "string"]
      : ["array", "dict", "number", "bool", "null", "name", "string", "hex", "ref"];
  const choice = choices[randomInt(rng, 0, choices.length - 1)];

  if (choice === "array") {
    const items = Array.from({ length: randomInt(rng, 0, 5) }, () =>
      randomPdfValue(rng, depth + 1)
    );
    return `[${items.join(" ")}]`;
  }
  if (choice === "dict") {
    const entries = [];
    for (let index = 0; index < randomInt(rng, 0, 4); index += 1) {
      entries.push(`/${randomName(rng)} ${randomPdfValue(rng, depth + 1)}`);
    }
    return `<< ${entries.join(" ")} >>`;
  }
  if (choice === "number") {
    return String(randomInt(rng, -5000, 5000) / (randomBool(rng) ? 1 : 10));
  }
  if (choice === "bool") {
    return randomBool(rng) ? "true" : "false";
  }
  if (choice === "null") {
    return "null";
  }
  if (choice === "name") {
    return `/${randomName(rng)}`;
  }
  if (choice === "string") {
    return `(${randomString(rng)})`;
  }
  if (choice === "hex") {
    return `<${randomHex(rng, randomInt(rng, 0, 12))}>`;
  }

  return `${randomInt(rng, 1, 20)} ${randomInt(rng, 0, 3)} R`;
}

export function randomContentStream(rng) {
  const operators = [
    "q",
    "Q",
    "BT",
    "ET",
    "/F1 12 Tf",
    `${randomInt(rng, -100, 100)} ${randomInt(rng, -100, 100)} Td`,
    `${randomInt(rng, 1, 20)} TL`,
    `(${randomString(rng)}) Tj`,
    `[(${randomString(rng)}) ${randomInt(rng, -300, 300)} (${randomString(rng)})] TJ`,
    `${randomInt(rng, 0, 2)} 0 0 ${randomInt(rng, 0, 2)} ${randomInt(rng, -50, 50)} ${randomInt(
      rng,
      -50,
      50
    )} cm`
  ];
  return Array.from({ length: randomInt(rng, 1, 30) }, () => operators[randomInt(rng, 0, operators.length - 1)]).join(
    "\n"
  );
}

function randomName(rng) {
  const parts = ["A", "Name", "F1", "Example#20Name", "X", "Length", "Root"];
  return parts[randomInt(rng, 0, parts.length - 1)];
}

function randomString(rng) {
  const parts = ["hello", "with\\nnewline", "paren\\(value\\)", "octal\\101", ""];
  return parts[randomInt(rng, 0, parts.length - 1)];
}

function randomHex(rng, length) {
  const chars = "0123456789ABCDEF";
  return randomAscii(rng, length, chars);
}
