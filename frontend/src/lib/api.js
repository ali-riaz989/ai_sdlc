import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' }
});

api.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('token');
      if (token) config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const apiClient = {
  // Auth
  login: (email, password) => api.post('/api/auth/login', { email, password }),
  register: (name, email, password) => api.post('/api/auth/register', { name, email, password }),
  getMe: () => api.get('/api/auth/me'),

  // Projects
  getProjects: () => api.get('/api/projects'),
  getProject: (id) => api.get(`/api/projects/${id}`),
  createProject: (data) => api.post('/api/projects', data),
  syncProject: (id, gitToken) => api.post(`/api/projects/${id}/sync`, { git_token: gitToken }),
  resolveRoute: (id, url) => api.post(`/api/projects/${id}/resolve-route`, { url }),
  listSections: (id) => api.get(`/api/projects/${id}/sections`),
  ensureSectionPreviews: (id) => api.post(`/api/projects/${id}/ensure-section-previews`),
  createPage: (id, data) => api.post(`/api/projects/${id}/pages`, data, { timeout: 30000 }),
  deleteProject: (id) => api.delete(`/api/projects/${id}`),

  // Change Requests
  quickChangeRequest: (data) => api.post('/api/change-requests/quick', data),
  createChangeRequest: (data) => api.post('/api/change-requests', data),
  getChangeRequest: (id) => api.get(`/api/change-requests/${id}`),
  listChangeRequests: (filters = {}) => api.get('/api/change-requests', { params: filters }),
  applyChangeRequest: (id) => api.post(`/api/change-requests/${id}/apply`),
  rejectChangeRequest: (id) => api.post(`/api/change-requests/${id}/reject`),
  restoreChangeRequest: (id) => api.post(`/api/change-requests/${id}/restore`),

  // Git operations
  pushProject: (id, commitMessage, gitToken) => api.post(`/api/projects/${id}/push`, { commit_message: commitMessage, git_token: gitToken }),
  resetProject: (id) => api.post(`/api/projects/${id}/reset`),

  // Chat persistence
  saveChatMessage: (projectId, msg) => api.post(`/api/projects/${projectId}/chat-messages`, msg),
  loadChatMessages: (projectId, params = {}) => api.get(`/api/projects/${projectId}/chat-messages`, { params }),

  // Users (admin only)
  listUsers: () => api.get('/api/users'),
  createUser: (data) => api.post('/api/users', data),
  updateUser: (id, data) => api.patch(`/api/users/${id}`, data),
  deleteUser: (id) => api.delete(`/api/users/${id}`),
  listUserChangeRequests: (id, params = {}) => api.get(`/api/users/${id}/change-requests`, { params }),
  impersonateUser: (id) => api.post(`/api/users/${id}/impersonate`),
};

export default api;
