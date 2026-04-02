// screw-up - Easy package metadata inserter on Vite plugin
// Copyright (c) Kouji Matsui (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/screw-up/

//////////////////////////////////////////////////////////////////////////////////

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface LineColumnOffset {
  readonly line: number;
  readonly column: number;
}

const readNewlineAt = (value: string, index: number): string | undefined => {
  if (index < 0 || index >= value.length) {
    return undefined;
  }
  if (value.startsWith('\r\n', index)) {
    return '\r\n';
  }
  const char = value[index];
  if (char === '\n' || char === '\r') {
    return char;
  }
  return undefined;
};

const findFirstNewline = (value: string): string | undefined => {
  for (let index = 0; index < value.length; index++) {
    const newline = readNewlineAt(value, index);
    if (newline) {
      return newline;
    }
  }
  return undefined;
};

const findPreviousNewline = (
  value: string,
  index: number
): string | undefined => {
  for (let current = index - 1; current >= 0; current--) {
    if (value[current] === '\n') {
      return current > 0 && value[current - 1] === '\r' ? '\r\n' : '\n';
    }
    if (value[current] === '\r') {
      return '\r';
    }
  }
  return undefined;
};

export const applyTextEdits = (
  value: string,
  edits: readonly TextEdit[]
): string => {
  if (edits.length === 0) {
    return value;
  }

  const sorted = [...edits].sort((lhs, rhs) => rhs.start - lhs.start);
  let result = value;
  let previousStart = value.length;

  for (const edit of sorted) {
    if (edit.start > edit.end) {
      throw new Error(`Invalid text edit range: ${edit.start} > ${edit.end}`);
    }
    if (edit.end > previousStart) {
      throw new Error('Overlapping text edits are not supported');
    }
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previousStart = edit.start;
  }

  return result;
};

export const detectPreferredNewline = (
  value: string,
  start: number,
  end: number
): string => {
  const within = findFirstNewline(value.slice(start, end));
  if (within) {
    return within;
  }

  const adjacent = readNewlineAt(value, end);
  if (adjacent) {
    return adjacent;
  }

  const after = findFirstNewline(value.slice(end));
  if (after) {
    return after;
  }

  const before = findPreviousNewline(value, start);
  if (before) {
    return before;
  }

  return findFirstNewline(value) ?? '\n';
};

export const collectLineStarts = (value: string): readonly number[] => {
  const starts = [0];

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\r') {
      if (value[index + 1] === '\n') {
        index += 1;
      }
      starts.push(index + 1);
      continue;
    }
    if (char === '\n') {
      starts.push(index + 1);
    }
  }

  return starts;
};

export const getLineColumnOffset = (
  lineStarts: readonly number[],
  offset: number
): LineColumnOffset => {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const lineStart = lineStarts[middle];
    const nextStart =
      middle + 1 < lineStarts.length
        ? lineStarts[middle + 1]
        : Number.MAX_SAFE_INTEGER;

    if (offset < lineStart) {
      high = middle - 1;
      continue;
    }
    if (offset >= nextStart) {
      low = middle + 1;
      continue;
    }

    return {
      line: middle,
      column: offset - lineStart,
    };
  }

  const lastLine = Math.max(0, lineStarts.length - 1);
  return {
    line: lastLine,
    column: offset - lineStarts[lastLine],
  };
};
