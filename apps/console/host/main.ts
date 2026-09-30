import { createApp } from 'vue';
import { bootstrapConsoleSession, resumeConsoleSession } from '../src/auth/bootstrap.ts';
import { ControlClient } from '../src/auth/client.ts';
import ConsoleHostView from '../views/ConsoleHostView.vue';

async function start(): Promise<void> {
  const origin = window.location.origin;
  const client = new ControlClient({ origin, fetchImpl: window.fetch.bind(window) });
  let startupMessage: string | null = null;
  try {
    const environment = {
      location: {
        hash: window.location.hash,
        pathname: window.location.pathname,
        origin,
      },
      history: window.history,
      fetchImpl: window.fetch.bind(window),
    };
    const session = await bootstrapConsoleSession(environment) ??
      await resumeConsoleSession({ fetchImpl: environment.fetchImpl, origin });
    if (session !== null) client.setSession(session);
    else startupMessage = '当前浏览器没有有效会话。请从仍已连接的控制台生成浏览器接入链接，或重新运行本地启动脚本。';
  } catch (error) {
    startupMessage = error instanceof Error ? error.message : '控制台会话建立失败。';
  }

  createApp(ConsoleHostView, { client, startupMessage }).mount('#app');
}

void start();
