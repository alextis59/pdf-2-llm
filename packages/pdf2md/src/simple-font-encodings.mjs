const encodingCodePoints = Object.freeze({
  WinAnsiEncoding: codePointTable("-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,8226,8364,8226,8218,402,8222,8230,8224,8225,710,8240,352,8249,338,8226,381,8226,8226,8216,8217,8220,8221,8226,8211,8212,732,8482,353,8250,339,8226,382,376,32,161,162,163,164,165,166,167,168,169,170,171,172,45,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255"),
  MacRomanEncoding: codePointTable("-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,-1,196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,239,241,243,242,244,246,245,250,249,251,252,8224,176,162,163,167,8226,182,223,174,169,8482,180,168,-1,198,216,-1,177,-1,-1,165,181,-1,-1,-1,-1,-1,170,186,-1,230,248,191,161,172,-1,402,-1,-1,171,187,8230,32,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,-1,255,376,8260,164,8249,8250,64257,64258,8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,-1,210,218,219,217,305,710,732,175,728,729,730,184,733,731,711"),
  StandardEncoding: codePointTable("-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,32,33,34,35,36,37,38,8217,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,8216,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,161,162,163,8260,165,402,167,164,39,8220,171,8249,8250,64257,64258,-1,8211,8224,8225,183,-1,182,8226,8218,8222,8221,187,8230,8240,-1,191,-1,96,180,710,732,175,728,729,168,-1,730,184,-1,733,731,711,8212,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,198,-1,170,-1,-1,-1,-1,321,216,338,186,-1,-1,-1,-1,-1,230,-1,-1,-1,305,-1,-1,322,248,339,223,-1,-1,-1,-1")
});

const glyphNameCodePoints = new Map(
  [
    "A=41;AE=C6;Aacute=C1;Acircumflex=C2;Adieresis=C4;Agrave=C0;Aring=C5;Atilde=C3;B=42;C=43;Ccedilla=C7;D=44;E=45;Eacute=C9;Ecircumflex=CA;Edieresis=CB;Egrave=C8;Eth=D0;Euro=20AC;F=46",
    "G=47;H=48;I=49;Iacute=CD;Icircumflex=CE;Idieresis=CF;Igrave=CC;J=4A;K=4B;L=4C;Lslash=141;M=4D;N=4E;Ntilde=D1;O=4F;OE=152;Oacute=D3;Ocircumflex=D4;Odieresis=D6;Ograve=D2",
    "Oslash=D8;Otilde=D5;P=50;Q=51;R=52;S=53;Scaron=160;T=54;Thorn=DE;U=55;Uacute=DA;Ucircumflex=DB;Udieresis=DC;Ugrave=D9;V=56;W=57;X=58;Y=59;Yacute=DD;Ydieresis=178",
    "Z=5A;Zcaron=17D;a=61;aacute=E1;acircumflex=E2;acute=B4;adieresis=E4;ae=E6;agrave=E0;ampersand=26;aring=E5;asciicircum=5E;asciitilde=7E;asterisk=2A;at=40;atilde=E3;b=62;backslash=5C;bar=7C;braceleft=7B",
    "braceright=7D;bracketleft=5B;bracketright=5D;breve=2D8;brokenbar=A6;bullet=2022;c=63;caron=2C7;ccedilla=E7;cedilla=B8;cent=A2;circumflex=2C6;colon=3A;comma=2C;copyright=A9;currency=A4;d=64;dagger=2020;daggerdbl=2021;degree=B0",
    "dieresis=A8;divide=F7;dollar=24;dotaccent=2D9;dotlessi=131;e=65;eacute=E9;ecircumflex=EA;edieresis=EB;egrave=E8;eight=38;ellipsis=2026;emdash=2014;endash=2013;equal=3D;eth=F0;exclam=21;exclamdown=A1;f=66;fi=FB01",
    "five=35;fl=FB02;florin=192;four=34;fraction=2044;g=67;germandbls=DF;grave=60;greater=3E;guillemotleft=AB;guillemotright=BB;guilsinglleft=2039;guilsinglright=203A;h=68;hungarumlaut=2DD;hyphen=2D;i=69;iacute=ED;icircumflex=EE;idieresis=EF",
    "igrave=EC;j=6A;k=6B;l=6C;less=3C;logicalnot=AC;lslash=142;m=6D;macron=AF;mu=B5;multiply=D7;n=6E;nine=39;ntilde=F1;numbersign=23;o=6F;oacute=F3;ocircumflex=F4;odieresis=F6;oe=153",
    "ogonek=2DB;ograve=F2;one=31;onehalf=BD;onequarter=BC;onesuperior=B9;ordfeminine=AA;ordmasculine=BA;oslash=F8;otilde=F5;p=70;paragraph=B6;parenleft=28;parenright=29;percent=25;period=2E;periodcentered=B7;perthousand=2030;plus=2B;plusminus=B1",
    "q=71;question=3F;questiondown=BF;quotedbl=22;quotedblbase=201E;quotedblleft=201C;quotedblright=201D;quoteleft=2018;quoteright=2019;quotesinglbase=201A;quotesingle=27;r=72;registered=AE;ring=2DA;s=73;scaron=161;section=A7;semicolon=3B;seven=37;six=36",
    "slash=2F;space=20;sterling=A3;t=74;thorn=FE;three=33;threequarters=BE;threesuperior=B3;tilde=2DC;trademark=2122;two=32;twosuperior=B2;u=75;uacute=FA;ucircumflex=FB;udieresis=FC;ugrave=F9;underscore=5F;v=76;w=77",
    "x=78;y=79;yacute=FD;ydieresis=FF;yen=A5;z=7A;zcaron=17E;zero=30"
  ]
    .join(";")
    .split(";")
    .map((entry) => {
      const [name, codePoint] = entry.split("=");
      return [name, Number.parseInt(codePoint, 16)];
    })
);

export function simpleEncodingCodePoint(encoding, byte) {
  return encodingCodePoints[encoding]?.[byte] ?? -1;
}

export function isSupportedSimpleEncoding(encoding) {
  return Object.hasOwn(encodingCodePoints, encoding);
}

export function unicodeForGlyphName(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const name = value.split(".", 1)[0];
  if (name.includes("_")) {
    const parts = name.split("_").map(unicodeForGlyphName);
    return parts.every((part) => part !== null) ? parts.join("") : null;
  }
  const knownCodePoint = glyphNameCodePoints.get(name);
  if (knownCodePoint !== undefined) {
    return String.fromCodePoint(knownCodePoint);
  }
  if (/^uni(?:[0-9A-Fa-f]{4})+$/.test(name)) {
    return name
      .slice(3)
      .match(/.{4}/g)
      .map((hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .join("");
  }
  if (/^u[0-9A-Fa-f]{4,6}$/.test(name)) {
    const codePoint = Number.parseInt(name.slice(1), 16);
    if (codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return String.fromCodePoint(codePoint);
    }
  }
  return null;
}

function codePointTable(value) {
  const table = value.split(",").map(Number);
  if (table.length !== 256) {
    throw new Error(`Simple font encoding table must have 256 entries, got ${table.length}`);
  }
  return Object.freeze(table);
}
