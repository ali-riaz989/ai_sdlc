'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import socketClient from '@/lib/socket';

const AuthContext = createContext(null);

// Storage keys
//   token             — currently-active JWT (admin's own OR an impersonation JWT)
//   original_token    — set ONLY while impersonating; admin's real JWT
//   original_user     — set ONLY while impersonating; admin's user payload
const TOKEN = 'token';
const ORIG_TOKEN = 'original_token';
const ORIG_USER = 'original_user';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // When non-null, the current session is an admin acting as another user.
  // Carries the admin's basic info so the banner can say "Impersonating X · ack <admin name>".
  const [impersonatedBy, setImpersonatedBy] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN);
    if (token) {
      apiClient.getMe()
        .then(res => {
          setUser(res.data);
          socketClient.connect(token);
          // Restore impersonation banner across reloads
          const origUser = localStorage.getItem(ORIG_USER);
          if (localStorage.getItem(ORIG_TOKEN) && origUser) {
            try { setImpersonatedBy(JSON.parse(origUser)); } catch { /* ignore */ }
          }
        })
        .catch(() => {
          localStorage.removeItem(TOKEN);
          localStorage.removeItem(ORIG_TOKEN);
          localStorage.removeItem(ORIG_USER);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  async function login(email, password) {
    const res = await apiClient.login(email, password);
    localStorage.setItem(TOKEN, res.data.token);
    localStorage.removeItem(ORIG_TOKEN);
    localStorage.removeItem(ORIG_USER);
    setUser(res.data.user);
    setImpersonatedBy(null);
    socketClient.connect(res.data.token);
    return res.data;
  }

  function logout() {
    localStorage.removeItem(TOKEN);
    localStorage.removeItem(ORIG_TOKEN);
    localStorage.removeItem(ORIG_USER);
    setUser(null);
    setImpersonatedBy(null);
    socketClient.disconnect();
  }

  // Stash the admin's token + identity, swap to the editor's token, reload so
  // every component re-mounts under the new identity (chat thread, role-based
  // nav, project detail page, etc.) without us having to thread state through
  // ad-hoc.
  async function impersonate(targetUserId) {
    const res = await apiClient.impersonateUser(targetUserId);
    const adminToken = localStorage.getItem(TOKEN);
    if (adminToken && user) {
      localStorage.setItem(ORIG_TOKEN, adminToken);
      localStorage.setItem(ORIG_USER, JSON.stringify(user));
    }
    localStorage.setItem(TOKEN, res.data.token);
    socketClient.disconnect();
    socketClient.connect(res.data.token);
    setUser(res.data.user);
    setImpersonatedBy(res.data.impersonated_by);
    // Force a hard reload so any in-memory state tied to the previous identity
    // (cached project list, in-flight sockets, paginated chat) starts clean.
    if (typeof window !== 'undefined') window.location.href = '/';
  }

  // Restore the admin's original session from the stashed token. No backend
  // call — we just swap localStorage back and reload.
  function stopImpersonation() {
    const orig = localStorage.getItem(ORIG_TOKEN);
    if (!orig) return;
    localStorage.setItem(TOKEN, orig);
    localStorage.removeItem(ORIG_TOKEN);
    localStorage.removeItem(ORIG_USER);
    socketClient.disconnect();
    socketClient.connect(orig);
    setImpersonatedBy(null);
    if (typeof window !== 'undefined') window.location.href = '/';
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, impersonate, stopImpersonation, impersonatedBy }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
