# FlowAI Web UI

This repository contains the Go Web UI service and its embedded operator interface.
Set the listener with `WEB_UI_BIND_HOST` and `WEB_UI_BIND_PORT`. The example
configuration uses port 8080.

Run Go unit tests with `go test -mod=readonly ./...`. The qualification workflow
also runs the locked Playwright browser unit suite on a dedicated hosted runner
using one worker. The suite serves the real application image through the Web
UI's in-process mocked API and WebSocket proxy. The workflow builds the untagged
image once, verifies browser and container teardown, and inspects the same local
image ID after the tests.
