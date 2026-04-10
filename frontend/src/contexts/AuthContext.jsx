'use client';

import { createContext, useContext, useState, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import socketClient from '@/lib/socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      apiClient.getMe()
        .then(res => {
          setUser(res.data);
          socketClient.connect(token);
        })
        .catch(() => {
          localStorage.removeItem('token');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  async function login(email, password) {
    const res = await apiClient.login(email, password);
    localStorage.setItem('token', res.data.token);
    setUser(res.data.user);
    socketClient.connect(res.data.token);
    return res.data;
  }

  function logout() {
    localStorage.removeItem('token');
    setUser(null);
    socketClient.disconnect();
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
