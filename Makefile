.PHONY: generate generate-go generate-ts server client-build \
	serve serve-local serve-local-down \
	serve-local-rebuild serve-local-rebuild-server serve-local-rebuild-client

generate: generate-go generate-ts

generate-go:
	cd idl && buf generate

generate-ts:
	cd client && pnpm exec buf generate

server:
	cd server && go run .

client-dev:
	cd client && pnpm dev

client-build:
	cd client && pnpm build

serve: ## Run published container images
	docker compose --profile serve up

serve-local: ## Build and run locally built containers
	docker image rm ghcr.io/cornerstone-production/stage-utility/server:local || true
	docker image rm ghcr.io/cornerstone-production/stage-utility/client:local || true
	docker compose --profile serve-local build
	docker compose --profile serve-local up

serve-local-down: ## Stop locally built containers
	docker compose --profile serve-local down

serve-local-rebuild: ## Rebuild and restart both local containers
	docker compose --profile serve-local up --detach --build

serve-local-rebuild-server: ## Rebuild and restart the local API server
	docker compose --profile serve-local up --detach --build server-local

serve-local-rebuild-client: ## Rebuild and restart the local web client
	docker compose --profile serve-local up --detach --build client-local
