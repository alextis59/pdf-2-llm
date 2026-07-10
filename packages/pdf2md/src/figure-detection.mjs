const figureCaptionPattern = /^Figure\s+([A-Za-z0-9.-]+)/i;

export function createFigureDetections({
  imageDraws = [],
  layout = null,
  pages = [],
  rulingLines = []
} = {}) {
  const pageByIndex = new Map(pages.map((page) => [page.pageIndex, page]));
  const linesByPage = groupByPage(rulingLines);
  const imagesByPage = groupByPage(imageDraws);
  const figures = [];

  for (const layoutPage of layout?.pages ?? []) {
    const pageIndex = layoutPage.pageIndex ?? null;
    const captions = (layoutPage.captions ?? []).filter((caption) => caption.target === "figure");
    for (const caption of captions) {
      const captionNumber = readCaptionNumber(caption);
      const vectorRegion = visualRegionAboveCaption(linesByPage.get(pageIndex) ?? [], caption);
      const imageRegion = visualRegionAboveCaption(imagesByPage.get(pageIndex) ?? [], caption);
      const visualRegion = vectorRegion ?? imageRegion;
      if (!visualRegion) {
        continue;
      }
      const figureNumber = figures.filter((figure) => figure.pageIndex === pageIndex).length + 1;
      figures.push({
        figureIndex: figures.length,
        pageIndex,
        figureNumber,
        captionNumber,
        caption: caption.text ?? null,
        previewStatus: "unavailable",
        fallbackReason: "preview-rendering-unavailable",
        kind: visualRegion.kind,
        x: visualRegion.x,
        y: visualRegion.y,
        width: visualRegion.width,
        height: visualRegion.height,
        visualElements: visualRegion.count,
        pageWidthPt: pageByIndex.get(pageIndex)?.widthPt ?? null,
        pageHeightPt: pageByIndex.get(pageIndex)?.heightPt ?? null,
        ...figureAltTextProperties(visualRegion)
      });
    }
  }

  return {
    total: figures.length,
    vectorFigures: figures.filter((figure) => figure.kind === "vector").length,
    imageFigures: figures.filter((figure) => figure.kind === "image").length,
    figures
  };
}

export function figureElementsByPage(figures) {
  const byPage = new Map();
  for (const figure of figures) {
    const elements = byPage.get(figure.pageIndex) ?? [];
    elements.push({
      type: "figure",
      caption: figure.caption ?? undefined,
      ...figureAltTextProperties(figure),
      x: figure.x,
      y: figure.y,
      width: figure.width,
      height: figure.height
    });
    byPage.set(figure.pageIndex, elements);
  }
  return byPage;
}

export function insertFigureMarkdown(markdownResult, figures) {
  if (figures.length === 0) {
    return markdownResult;
  }

  const usedCaptionRanges = [];
  const insertions = [];
  for (const figure of figures) {
    const insertion = createFigureMarkdownInsertion(markdownResult, figure, usedCaptionRanges);
    if (!insertion) {
      continue;
    }
    usedCaptionRanges.push(insertion.captionRange);
    insertions.push(insertion);
  }
  insertions.sort((left, right) => left.index - right.index);
  if (insertions.length === 0) {
    return markdownResult;
  }

  let markdown = markdownResult.markdown;
  let entries = (markdownResult.sourceMap?.entries ?? []).map((entry) => ({
    ...entry,
    regions: entry.regions.map((region) => ({ ...region }))
  }));
  let offset = 0;
  const figureEntries = [];

  for (const insertion of insertions) {
    const index = insertion.index + offset;
    markdown = `${markdown.slice(0, index)}${insertion.text}${markdown.slice(index)}`;
    entries = shiftSourceMapEntries(entries, index, insertion.text.length);
    figureEntries.push({
      markdownStart: index,
      markdownEnd: index + insertion.text.trimEnd().length,
      kind: "figure",
      regions: [
        {
          pageIndex: insertion.figure.pageIndex,
          x: insertion.figure.x,
          y: insertion.figure.y,
          width: insertion.figure.width,
          height: insertion.figure.height,
          source: insertion.figure.kind === "vector" ? "pdf-vector" : "pdf-image"
        }
      ]
    });
    offset += insertion.text.length;
  }

  return {
    ...markdownResult,
    markdown,
    sourceMap: {
      ...markdownResult.sourceMap,
      entries: [...entries, ...figureEntries].sort(
        (left, right) =>
          left.markdownStart - right.markdownStart || left.markdownEnd - right.markdownEnd
      )
    }
  };
}

function createFigureMarkdownInsertion(markdownResult, figure, usedCaptionRanges) {
  if (!figure.caption) {
    return null;
  }
  const index = findCaptionInsertionIndex(markdownResult, figure, usedCaptionRanges);
  if (index === -1) {
    return null;
  }
  return {
    captionRange: {
      start: index,
      end: index + figure.caption.length
    },
    figure,
    index,
    text: `*[Figure ${figure.captionNumber ?? figure.figureNumber} preview unavailable; metadata retained.]*\n\n`
  };
}

function findCaptionInsertionIndex(markdownResult, figure, usedCaptionRanges) {
  const markdown = markdownResult.markdown;
  const entries = markdownResult.sourceMap?.entries ?? [];
  let index = markdown.indexOf(figure.caption);
  while (index !== -1) {
    const end = index + figure.caption.length;
    if (
      !rangeWasUsed(index, end, usedCaptionRanges) &&
      captionRangeMatchesFigurePage(entries, index, end, figure.pageIndex)
    ) {
      return index;
    }
    index = markdown.indexOf(figure.caption, index + 1);
  }
  return -1;
}

function rangeWasUsed(start, end, ranges) {
  return ranges.some((range) => range.start === start && range.end === end);
}

function captionRangeMatchesFigurePage(entries, start, end, pageIndex) {
  if (entries.length === 0 || pageIndex === null || pageIndex === undefined) {
    return true;
  }
  return entries.some(
    (entry) =>
      rangesOverlap(start, end, entry.markdownStart, entry.markdownEnd) &&
      entry.regions?.some((region) => region.pageIndex === pageIndex)
  );
}

function shiftSourceMapEntries(sourceMap, insertionIndex, length) {
  return sourceMap.map((entry) => {
    if (entry.markdownEnd <= insertionIndex) {
      return entry;
    }
    if (entry.markdownStart < insertionIndex) {
      return {
        ...entry,
        markdownEnd: entry.markdownEnd + length
      };
    }
    return {
      ...entry,
      markdownStart: entry.markdownStart + length,
      markdownEnd: entry.markdownEnd + length
    };
  });
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function visualRegionAboveCaption(items, caption) {
  const candidates = items
    .map(regionFromVisualItem)
    .filter(Boolean)
    .filter((region) => region.y >= caption.y + caption.height);
  if (candidates.length === 0) {
    return null;
  }
  const bounds = boundsForRegions(candidates);
  return {
    kind: candidates.some((candidate) => candidate.kind === "image") ? "image" : "vector",
    ...bounds,
    count: candidates.length,
    ...figureAltTextProperties(firstAltTextCandidate(candidates))
  };
}

function regionFromVisualItem(item) {
  if (item?.type === "ruling-line") {
    const x = Math.min(item.x1, item.x2);
    const y = Math.min(item.y1, item.y2);
    return {
      kind: "vector",
      x,
      y,
      width: Math.abs(item.x2 - item.x1),
      height: Math.abs(item.y2 - item.y1),
      ...figureAltTextProperties(item)
    };
  }
  if (Number.isFinite(item?.x) && Number.isFinite(item?.y)) {
    return {
      kind: "image",
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      ...figureAltTextProperties(item)
    };
  }
  return null;
}

function firstAltTextCandidate(candidates) {
  return candidates.find((candidate) => normalizeAltText(candidate.altText)) ?? null;
}

function figureAltTextProperties(item) {
  const altText = normalizeAltText(item?.altText);
  if (!altText) {
    return {};
  }
  return {
    altText,
    altTextSource: item.altTextSource ?? "tagged-pdf"
  };
}

function normalizeAltText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function boundsForRegions(regions) {
  const minX = Math.min(...regions.map((region) => region.x));
  const minY = Math.min(...regions.map((region) => region.y));
  const maxX = Math.max(...regions.map((region) => region.x + region.width));
  const maxY = Math.max(...regions.map((region) => region.y + region.height));
  return {
    x: normalizeNumber(minX),
    y: normalizeNumber(minY),
    width: normalizeNumber(maxX - minX),
    height: normalizeNumber(maxY - minY)
  };
}

function readCaptionNumber(caption) {
  const match = caption.text?.match(figureCaptionPattern);
  return match?.[1]?.replace(/[.:]+$/, "") ?? null;
}

function groupByPage(items) {
  const byPage = new Map();
  for (const item of items) {
    const pageIndex = item.pageIndex ?? null;
    const pageItems = byPage.get(pageIndex) ?? [];
    pageItems.push(item);
    byPage.set(pageIndex, pageItems);
  }
  return byPage;
}

function normalizeNumber(value) {
  return Number.parseFloat(value.toFixed(6));
}
