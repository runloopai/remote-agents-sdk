FROM runloop:runloop/starter-x86_64

RUN npm install -g @zed-industries/codex-acp @openai/codex@0.144.1

USER user
WORKDIR /home/user

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://opencode.ai/install | bash
