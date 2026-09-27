import { createApp } from 'vue';
import { bootstrapConsoleSession } from '../src/auth/bootstrap.ts';
import { ControlClient } from '../src/auth/client.ts';
import ConsoleHostView from '../views/ConsoleHostView.vue';

async function start(): Promise<void> {
  const origin = window.location.origin;
  const client = new ControlClient({ origin, fetchImpl: window.fetch.bind(window) });
  let startupMessage: string | null = null;
  try {
    const session = await bootstrapConsoleSession({
      location: {
        hash: window.location.hash,
        pathname: window.location.pathname,
        origin,
      },
      history: window.history,
      fetchImpl: window.fetch.bind(window),
    });
    if (session !== null) client.setSession(session);
    else startupMessage = '请从 daemon 终端复制本次启动链接，在本机浏览器中打开以建立控制台会话。';
  } catch (error) {
    startupMessage = error instanceof Error ? error.message : '控制台会话建立失败。';
  }

  createApp(ConsoleHostView, { client, startupMessage }).mount('#app');
}

void start();
