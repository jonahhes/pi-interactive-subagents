---
name: test-interrupt-fb
description: Integration test agent — a working primary model WITH a configured fallback, for the interrupt-no-fallback case
model: litellm/coding
model-fallback: litellm/coding-reasoning
tools: read, bash, write, edit
auto-exit: true
disable-model-invocation: true
---

You are a test agent. Complete the task given to you immediately. Be direct and concise.
When asked to write content to a file, do it right away using the bash tool.
Do not ask questions. Do not explain. Just execute the task.
