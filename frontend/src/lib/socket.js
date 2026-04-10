import { io } from 'socket.io-client';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

class SocketClient {
  constructor() {
    this.socket = null;
    this.listeners = new Map();
  }

  connect(token) {
    if (this.socket?.connected) return this.socket;

    this.socket = io(WS_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });

    this.socket.on('connect', () => console.log('WebSocket connected'));
    this.socket.on('disconnect', () => console.log('WebSocket disconnected'));
    this.socket.on('connect_error', (err) => console.error('WebSocket error:', err.message));

    return this.socket;
  }

  subscribeToChangeRequest(requestId, callback, fileCallback) {
    if (!this.socket) return;
    const event = `change-request:${requestId}`;
    const fileEvent = `change-request:${requestId}:files`;
    this.socket.emit('subscribe:change-request', requestId);
    this.socket.on(event, callback);
    this.listeners.set(event, callback);
    if (fileCallback) {
      this.socket.on(fileEvent, fileCallback);
      this.listeners.set(fileEvent, fileCallback);
    }
  }

  subscribeToProjectSetup(projectId, onLog, onQuestion) {
    if (!this.socket) return;
    this.socket.emit('subscribe:project-setup', projectId);
    this.socket.on('project:log', onLog);
    this.socket.on('project:question', onQuestion);
    this.listeners.set(`project-setup-log-${projectId}`, onLog);
    this.listeners.set(`project-setup-q-${projectId}`, onQuestion);
  }

  answerProjectQuestion(projectId, answer) {
    if (!this.socket) return;
    this.socket.emit('project:answer', { projectId, answer });
  }

  unsubscribeFromProjectSetup(projectId) {
    if (!this.socket) return;
    const logCb = this.listeners.get(`project-setup-log-${projectId}`);
    const qCb   = this.listeners.get(`project-setup-q-${projectId}`);
    if (logCb) { this.socket.off('project:log', logCb);      this.listeners.delete(`project-setup-log-${projectId}`); }
    if (qCb)   { this.socket.off('project:question', qCb);   this.listeners.delete(`project-setup-q-${projectId}`); }
  }

  onToken(requestId, callback) {
    if (!this.socket) return;
    const tokenEvent = `change-request:${requestId}:token`;
    this.socket.on(tokenEvent, callback);
    this.listeners.set(tokenEvent, callback);
  }

  unsubscribeFromChangeRequest(requestId) {
    if (!this.socket) return;
    const event = `change-request:${requestId}`;
    const fileEvent = `change-request:${requestId}:files`;
    const tokenEvent = `change-request:${requestId}:token`;
    [event, fileEvent, tokenEvent].forEach(ev => {
      const cb = this.listeners.get(ev);
      if (cb) { this.socket.off(ev, cb); this.listeners.delete(ev); }
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.listeners.clear();
    }
  }
}

export default new SocketClient();
