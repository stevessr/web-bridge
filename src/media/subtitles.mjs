function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSegments(input) {
  const source = Array.isArray(input) ? input : input?.segments;
  if (!Array.isArray(source)) throw new Error('ASR response does not contain a segments array');
  const segments = source
    .map((segment, index) => {
      const start = Math.max(0, finiteNumber(segment.start));
      const end = Math.max(start + 0.05, finiteNumber(segment.end, start + 2));
      const text = String(segment.text ?? segment.transcript ?? '').replace(/\s+/g, ' ').trim();
      return { index, start, end, text };
    })
    .filter((segment) => segment.text);
  if (!segments.length) throw new Error('ASR returned no non-empty subtitle segments');
  return segments;
}

function srtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function assTime(seconds) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function cleanSubtitleText(text) {
  return String(text || '').replace(/\r/g, '').trim();
}

export function segmentsToSrt(segments) {
  return `${segments.map((segment, index) => [
    index + 1,
    `${srtTime(segment.start)} --> ${srtTime(segment.end)}`,
    cleanSubtitleText(segment.text),
    ''
  ].join('\n')).join('\n')}\n`;
}

function escapeAss(text) {
  return cleanSubtitleText(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

export function segmentsToAss(segments, { title = 'web-bridge auto fansub', font = 'Noto Sans CJK SC' } = {}) {
  const events = segments.map((segment) => `Dialogue: 0,${assTime(segment.start)},${assTime(segment.end)},Default,,0,0,0,,${escapeAss(segment.text)}`).join('\n');
  return `[Script Info]\nTitle: ${title}\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},48,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,80,80,52,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events}\n`;
}
