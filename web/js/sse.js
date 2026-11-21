// Server-sent events over fetch (the chat endpoint is a POST, so EventSource can't be used).
// Lines starting with ":" are keepalive comments and are ignored.
export function splitEvents(buf) {
  const parts = buf.split("\n\n");
  const rest = parts.pop();
  const events = [];
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { events.push(JSON.parse(line.slice(5))); } catch { /* a garbled line is skipped, the stream goes on */ }
    }
  }
  return { events, rest };
}

export async function* readEvents(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = splitEvents(buf);
    buf = rest;
    yield* events;
  }
}

// Some models put their reasoning inline as <think>...</think> in the answer text. Split a raw answer into both.
// Recomputed from the full text each time, so a tag cut in half by the stream is handled.
export function splitThink(raw) {
  const t = raw.trimStart();
  if (!t.startsWith("<think>")) {
    return "<think>".startsWith(t) && t.length < 7 && t.length > 0 ? { think: "", answer: "" } : { think: "", answer: raw };
  }
  const end = t.indexOf("</think>");
  return end < 0 ? { think: t.slice(7), answer: "" } : { think: t.slice(7, end), answer: t.slice(end + 8).trimStart() };
}
