FROM runloop:runloop/starter-x86_64

RUN npm install -g @zed-industries/codex-acp
RUN npm install -g @earendil-works/pi-coding-agent@0.82.1

USER user
WORKDIR /home/user

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://opencode.ai/install | bash
RUN curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=true sh -s -- --release 0.144.1
