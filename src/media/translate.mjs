import { envValue } from './utils.mjs';

function parseJsonArray(text) {
  const cleaned = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`Translation response does not contain a JSON array: ${cleaned.slice(0, 500)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function translateBatch(config, batch, targetLanguage, { signal } = {}) {
  const apiKey = envValue(config.translation.apiKeyEnv, { required: true });
  const sourceLanguage = config.translation.sourceLanguage || 'auto';
  const payload = batch.map((segment) => ({ i: segment.index, text: segment.text }));
  const response = await fetch(`${config.translation.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.translation.model,
      temperature: 0.2,
      ...config.translation.extraBody,
      messages: [
        { role: 'system', content: config.translation.systemPrompt },
        {
          role: 'user',
          content: `Translate subtitle segments from ${sourceLanguage} to ${targetLanguage}. Return ONLY a JSON array with exactly one object per input item, preserving each i value: [{"i":0,"text":"translated subtitle"}]. Keep each subtitle concise and natural. Input:\n${JSON.stringify(payload)}`
        }
      ]
    }),
    signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Translation API ${response.status}: ${text.slice(0, 2000)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Translation API returned non-JSON envelope: ${text.slice(0, 500)}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Translation API response has no choices[0].message.content');
  const translated = parseJsonArray(content);
  const byIndex = new Map(translated.map((item) => [Number(item.i), String(item.text ?? '').trim()]));
  return batch.map((segment) => {
    const textValue = byIndex.get(segment.index);
    if (!textValue) throw new Error(`Translation response omitted segment ${segment.index}`);
    return { ...segment, text: textValue, originalText: segment.text };
  });
}

export async function translateSegments(config, segments, options = {}) {
  if (config.translation.backend === 'none') return segments.map((segment) => ({ ...segment }));
  const targetLanguage = config.translation.targetLanguage || config.targetLanguage;
  const translated = [];
  for (let offset = 0; offset < segments.length; offset += config.translation.batchSegments) {
    const batch = segments.slice(offset, offset + config.translation.batchSegments);
    translated.push(...await translateBatch(config, batch, targetLanguage, options));
  }
  return translated;
}
