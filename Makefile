# SSH Key Maker. Список команд: make help

APP := SSH Key Maker.app

.PHONY: all help build install icons run start clean

all: build

help: ## показати цей список
	@echo "Команди:"
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'

build: ## зібрати SSH Key Maker.app (те саме, що просто make)
	./build.sh

install: ## зібрати й встановити в /Applications (або ~/Applications)
	./build.sh --install

icons: ## лише перегенерувати іконки (icons/)
	./make-icons.sh

run: build ## зібрати й запустити
	open "$(APP)"

start: ## Electron-версія: за згодою встановити Node.js та Electron і запустити
	./start.sh

clean: ## прибрати зібране (.app та icons/)
	rm -rf "$(APP)" icons
