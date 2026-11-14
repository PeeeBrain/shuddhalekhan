// Streamed provider replies in the wire shapes the AI SDK parses. The runtime always streams.
const headers = { 'content-type': 'text/event-stream' };

export type ToolCallReply = { id: string; name: string; arguments: string };

export function chatReply(reply: string | ToolCallReply, finishReason?: 'length'): Response {
  const call = typeof reply !== 'string';
  const delta = call
    ? { tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.name, arguments: reply.arguments } }] }
    : { content: reply };
  const event = (value: unknown, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: 'completion', created: 1, model: 'test-model', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  return new Response(event(delta, null) + event({}, finishReason ?? (call ? 'tool_calls' : 'stop')) + 'data: [DONE]\n\n', { headers });
}

export function responsesReply(text: string): Response {
  const message = { type: 'message', id: 'message-1' };
  return new Response([
    { type: 'response.created', response: { id: 'response-1', created_at: 1, model: 'test-model' } },
    { type: 'response.output_item.added', output_index: 0, item: message },
    { type: 'response.output_text.delta', item_id: 'message-1', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers });
}
