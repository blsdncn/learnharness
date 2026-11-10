/** Offline Responses SSE fixtures, shared by transport and packaged tests. */
export function responseFrame(type, fields) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}
export function responseFrames(text = "socket fixture response", tool = false) {
	const item = tool
		? { id: "fc_fixture", type: "function_call", call_id: "call_fixture", name: "echo", arguments: '{"value":"ok"}', status: "completed" }
		: { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
	return [
		responseFrame("response.created", { response: { id: "resp_fixture", status: "in_progress", output: [] } }),
		responseFrame("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : { content: [] }) } }),
		...(tool ? [
			responseFrame("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: '{"value":' }),
			responseFrame("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: '"ok"}' }),
			responseFrame("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments }),
		] : [
			responseFrame("response.content_part.added", { output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } }),
			responseFrame("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: text }),
		]),
		responseFrame("response.output_item.done", { output_index: 0, item }),
		responseFrame("response.completed", { response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }),
	];
}
