# Attribution and third-party components

This project is based on https://github.com/Derpyu520/qq-bridge. The original MIT copyright notice is preserved in LICENSE. No upstream Git history was available in the source directory; this repository begins with a new source snapshot.

The project license applies to this project's code. Dependencies retain their own licenses. The repository does not bundle node_modules, DeepSeek Harness, SnowLuma executables, native platform components, Android toolchains, or private voice samples.

The dependency names and versions are declared in package.json and package-lock.json, including @deepseek-ai/*, @snowluma/sdk, @snowluma/mcp, @modelcontextprotocol/sdk, js-yaml, koffi, zod and zod-to-json-schema. Inspect each installed package's license before redistributing it. The existing postinstall script changes relative JavaScript import extensions in locally installed @snowluma packages; those modified dependency files are not published here. This snapshot does not grant additional rights to third-party components.

## Data leaving the machine

QQ messages, images and conversation context reach local DSH and the model provider configured in DSH. Replies and action parameters reach the OneBot gateway. The optional web tools send queries to Bing and fetch model-selected public URLs; slang auto-research is enabled in the example configuration. Optional TTS and other integrations send their inputs to the configured services. Review config.example.json and feature guides before enabling them.

SnowLuma and this project are independent of Tencent/QQ. This repository provides no platform authorization or endorsement.
