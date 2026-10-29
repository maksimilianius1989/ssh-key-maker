# SSH Key Maker (Electron). Список команд: make help

.PHONY: all help start icons clean

all: start

help: ## показати цей список
	@echo "Команди:"
	@grep -E '^[a-z]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'

start: ## за згодою встановити Node.js та Electron і запустити (те саме, що просто make)
	./start.sh

icons: ## перегенерувати іконки (icons/) з icon.png
	./make-icons.sh

clean: ## прибрати встановлений Electron (electron/node_modules)
	rm -rf electron/node_modules
