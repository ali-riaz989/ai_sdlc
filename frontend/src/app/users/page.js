'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

// Admin-only Users management page.
// Tab is hidden from editors via the conditional in the home header — this
// component additionally bounces non-admins to / to prevent direct URL access.
export default function UsersPage() {
  const { user, loading: authLoading, logout, impersonate } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | userObject
  const [busy, setBusy] = useState(false);
  const [impersonating, setImpersonating] = useState(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.replace('/login'); return; }
    if (user.role !== 'admin') { router.replace('/'); return; }
    refresh();
  }, [authLoading, user, router]);

  async function refresh() {
    setLoading(true);
    try {
      const res = await apiClient.listUsers();
      setUsers(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(u) {
    if (!confirm(`Delete user "${u.name}" (${u.email})? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await apiClient.deleteUser(u.id);
      await refresh();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleImpersonate(u) {
    if (impersonating) return;
    setImpersonating(u.id);
    try {
      await impersonate(u.id); // navigates to / on success, replacing this page
    } catch (err) {
      alert(err.response?.data?.error || err.message);
      setImpersonating(null);
    }
  }

  if (authLoading || !user) return null;
  if (user.role !== 'admin') return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">AI SDLC Platform</h1>
          <div className="flex items-center gap-4">
            <a href="/" className="text-sm text-gray-600 hover:text-gray-900">Dashboard</a>
            <a href="/users" className="text-sm font-medium text-blue-600">Users</a>
            <span className="text-sm text-gray-500">{user.name}</span>
            <button onClick={logout} className="text-sm text-gray-500 hover:text-gray-900">Logout</button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Users</h2>
            <p className="text-gray-500 text-sm mt-1">Manage editors and admins. Editors can use the AI editor; admins can also manage users and impersonate.</p>
          </div>
          <button
            onClick={() => setEditing('new')}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium">
            + Add User
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
        )}

        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-left px-4 py-3 font-medium">Last active</th>
                <th className="text-left px-4 py-3 font-medium">Changes</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr><td colSpan="6" className="text-center text-gray-500 py-12 text-sm">Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan="6" className="text-center text-gray-500 py-12 text-sm">No users.</td></tr>
              ) : users.map(u => {
                const lastActive = u.last_active_at ? new Date(u.last_active_at).toLocaleString() : '—';
                return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <a href={`/users/${u.id}`} className="text-gray-900 font-medium hover:text-blue-600">{u.name}</a>
                    </td>
                    <td className="px-4 py-3 text-gray-700 font-mono text-xs">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                        u.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-700'
                      }`}>{u.role}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{lastActive}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{u.change_request_count}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {u.id !== user.id && (
                        <button
                          onClick={() => handleImpersonate(u)}
                          disabled={!!impersonating}
                          title="Open the platform as this user — their AI prompts and chat will be attributed to them"
                          className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 disabled:opacity-50">
                          {impersonating === u.id ? 'Switching…' : 'Login as'}
                        </button>
                      )}
                      <button
                        onClick={() => setEditing(u)}
                        className="text-xs text-gray-700 hover:text-blue-600 px-2 py-1 ml-1">Edit</button>
                      {u.id !== user.id && (
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={busy}
                          className="text-xs text-gray-700 hover:text-red-600 px-2 py-1 ml-1 disabled:opacity-40">Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function UserModal({ user, onClose, onSaved }) {
  const isNew = !user;
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [role, setRole] = useState(user?.role || 'editor');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await apiClient.createUser({ name, email, role, password });
      } else {
        const patch = {};
        if (name !== user.name) patch.name = name;
        if (email !== user.email) patch.email = email;
        if (role !== user.role) patch.role = role;
        if (password.trim()) patch.password = password;
        if (Object.keys(patch).length === 0) { onClose(); return; }
        await apiClient.updateUser(user.id, patch);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md z-50">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{isNew ? 'Add user' : `Edit ${user.name}`}</h3>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 bg-white" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 bg-white" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Role</label>
            <select value={role} onChange={e => setRole(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white">
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Password {isNew ? '' : <span className="text-gray-400 font-normal">(leave blank to keep current)</span>}
            </label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              required={isNew} minLength={isNew ? 8 : 0}
              placeholder={isNew ? 'Min 8 characters' : '••••••••'}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 bg-white" />
          </div>

          {error && <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-xs">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={busy}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {busy ? 'Saving…' : (isNew ? 'Create' : 'Save')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
