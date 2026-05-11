'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.replace('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f9f9f9] px-4 py-12">
      <div
        className="w-full max-w-[400px] bg-white rounded-lg border border-[#e2e2e2] px-10 py-12"
        style={{ boxShadow: '0 1px 2px rgba(26,28,28,0.04), 0 8px 24px rgba(26,28,28,0.04)' }}
      >
        <div className="flex justify-center mb-10">
          <img
            src="/The-Parklane-Canvas-Logo.png"
            alt="The Parklane Canvas"
            className="h-14 w-auto"
          />
        </div>

        {error && (
          <div className="mb-6 px-3 py-2.5 bg-[#ffdad6] border border-[#ffb4ab] rounded text-sm text-[#93000a]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-[11px] font-semibold tracking-[0.1em] text-[#1a1c1c] mb-2">
              WORK EMAIL
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[#897266] pointer-events-none">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m3 7 9 6 9-6" />
                </svg>
              </span>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="name@company.com"
                className="w-full h-11 pl-10 pr-3 border border-[#ddc1b3] rounded text-sm text-[#1a1c1c] placeholder:text-[#897266] bg-white focus:outline-none focus:border-[#f6863d] focus:ring-1 focus:ring-[#f6863d] transition-colors"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[11px] font-semibold tracking-[0.1em] text-[#1a1c1c]">
                PASSWORD
              </label>
              <a href="#" className="text-[11px] font-semibold tracking-[0.1em] text-[#f6863d] hover:text-[#9b4600] transition-colors">
                FORGOT?
              </a>
            </div>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[#897266] pointer-events-none">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full h-11 pl-10 pr-3 border border-[#ddc1b3] rounded text-sm text-[#1a1c1c] placeholder:text-[#897266] bg-white focus:outline-none focus:border-[#f6863d] focus:ring-1 focus:ring-[#f6863d] transition-colors"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 bg-[#f6863d] text-[#9b4600] rounded text-[12px] font-semibold tracking-[0.1em] hover:bg-[#9b4600] hover:text-white disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
          >
            {loading ? 'SIGNING IN…' : (
              <>
                SIGN IN
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" />
                  <path d="m12 5 7 7-7 7" />
                </svg>
              </>
            )}
          </button>
        </form>

        <div className="mt-10 pt-6 border-t border-[#e2e2e2] text-center">
          <p className="text-xs text-[#564338]">
            Don&apos;t have an account?{' '}
            <span className="text-[#f6863d] font-semibold">Contact Administrator</span>
          </p>
        </div>
      </div>
    </div>
  );
}
