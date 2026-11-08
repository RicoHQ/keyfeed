// Generates synthetic .osu mania charts for demo mode and tests.
// style: stream | jumpstream | handstream | jack | chordjack | tech | ln

export function makeOsu({ keys = 4, style = 'stream', nps = 10, seconds = 90, seed = 1, title = 'Demo', version = 'Demo' }) {
  let s = seed >>> 0 || 1;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (n, exclude = new Set()) => {
    const cols = [...Array(keys).keys()].filter((c) => !exclude.has(c));
    const out = new Set();
    while (out.size < Math.min(n, cols.length)) out.add(cols[Math.floor(r() * cols.length)]);
    return out;
  };
  const chordSize = { stream: 1, jumpstream: 2, handstream: Math.max(3, Math.ceil(keys * 0.6)), jack: 1, chordjack: Math.max(2, Math.floor(keys / 2)), tech: 1, ln: 1 }[style] || 1;
  const avgRow = style === 'jumpstream' || style === 'handstream' ? (chordSize + 1) / 2 : chordSize;
  const rowsPerSec = nps / avgRow;
  const baseGap = 1000 / rowsPerSec;
  const lines = [];
  let t = 1000;
  let prev = new Set();
  let alt = false;
  const end = 1000 + seconds * 1000;
  while (t < end) {
    let cols;
    if (style === 'jack') cols = r() < 0.7 && prev.size ? new Set([[...prev][0]]) : pick(1);
    else if (style === 'chordjack') cols = r() < 0.6 && prev.size ? new Set([...[...prev].slice(0, 1), ...pick(chordSize - 1)]) : pick(chordSize);
    else if (style === 'jumpstream' || style === 'handstream') {
      // alternate chords with single notes, like real jumpstream/handstream
      cols = alt ? pick(1, prev) : pick(chordSize, prev.size + chordSize <= keys ? prev : new Set());
      alt = !alt;
    } else cols = pick(chordSize, prev);
    for (const c of cols) {
      const x = Math.floor(((c + 0.5) * 512) / keys);
      if (style === 'ln' && r() < 0.7) {
        const len = Math.round(baseGap * (1 + Math.floor(r() * 4)) + r() * 37);
        lines.push(`${x},192,${Math.round(t)},128,0,${Math.round(t + len)}:0:0:0:0:`);
      } else lines.push(`${x},192,${Math.round(t)},1,0,0:0:0:0:`);
    }
    prev = cols;
    const gap = style === 'tech' ? baseGap * [0.5, 0.75, 1, 1.5, 0.66, 1.33][Math.floor(r() * 6)] : baseGap;
    t += gap;
  }
  return `osu file format v14

[General]
Mode: 3

[Metadata]
Title:${title}
Artist:keyfeed demo
Creator:generator
Version:${version}

[Difficulty]
CircleSize:${keys}
OverallDifficulty:8

[HitObjects]
${lines.join('\n')}
`;
}
