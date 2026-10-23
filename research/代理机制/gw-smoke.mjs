// 06 分册 §7 的实测脚本：用桩 complete() 起网关，验六条路径，不碰网络。
// 用法：node research/代理机制/gw-smoke.mjs
import { startForwardServer, generateKey } from '../../src/forward.js'

const KEY = generateKey()

// 唯一需要实现的东西：把任意上游变成 { text, toolCalls, usage }
async function complete(request, onChunk) {
  const text = 'pong:' + request.model
  for (const ch of text) onChunk?.({ type: 'text-delta', text: ch })
  return { text, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }
}

const { port } = await startForwardServer({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, key: KEY }),
  complete,
  modelRows: () => [{ id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'mine' }],
  log: m => console.error('[gw]', m),
})

const base = `http://127.0.0.1:${port}`
const show = async (label, p) => {
  const r = await p
  console.log(label, r.status, (await r.text()).slice(0, 200))
}
const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }
const body = JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] })

await show('health     ', fetch(`${base}/health`))
await show('models-401 ', fetch(`${base}/v1/models`))
await show('models-ok  ', fetch(`${base}/v1/models`, { headers: auth }))
await show('chat-nonstr', fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body }))
await show('chat-stream', fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ ...JSON.parse(body), stream: true }) }))
await show('anthropic  ', fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
}))
process.exit(0)
