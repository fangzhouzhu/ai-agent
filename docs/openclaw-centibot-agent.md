# OpenClaw + Centibot Agent 接入说明

Centibot 启动后会暴露一个本地 OpenAI-compatible Agent 服务，供 OpenClaw Gateway 路由微信 ClawBot 消息。

## 本地 Agent 地址

- Base URL: `http://127.0.0.1:18790/v1`
- Chat Completions: `http://127.0.0.1:18790/v1/chat/completions`
- Models: `http://127.0.0.1:18790/v1/models`
- Health: `http://127.0.0.1:18790/health`
- Manifest: `http://127.0.0.1:18790/openclaw/agent.json`
- Model: `centibot-current`
- API Key: 本地模式不校验，可填写任意占位值，例如 `centibot-local`

## OpenClaw 配置

把 Centibot 注册成 OpenClaw 的 OpenAI Chat Completions 兼容 provider：

```powershell
openclaw config set models.providers.centibot '{"api":"openai-completions","baseUrl":"http://127.0.0.1:18790/v1","apiKey":"centibot-local","models":{"centibot-current":{"contextWindow":128000}}}' --strict-json --merge
```

把默认 Agent 模型指向 Centibot：

```powershell
openclaw config set agents.defaults.model '{"primary":"centibot/centibot-current","fallbacks":[]}' --strict-json --merge
```

登录微信通道并启动 Gateway：

```powershell
openclaw channels login --channel openclaw-weixin
openclaw gateway
```

## 请求格式

接口兼容 OpenAI Chat Completions：

```json
{
  "model": "centibot-current",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false
}
```

`stream: true` 时返回 SSE chunk，`stream: false` 时返回普通 JSON。

## 推荐链路

微信 ClawBot / OpenClaw Weixin Channel -> OpenClaw Gateway -> Centibot Agent -> OpenClaw Gateway -> 微信

Centibot 负责模型、Skills、RAG 和工具策略；OpenClaw 负责微信通道、消息路由和回发。
