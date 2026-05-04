'use client';

import { useAuth } from '@/contexts/AuthContext';

// Visible across every page whenever the user's session was opened via the
// "Login as" admin flow. Sticks to the top, above the regular header, so the
// admin can never forget they're acting on someone else's behalf. Click "Stop"
// to drop the impersonation token and resume the admin session.
export default function ImpersonationBanner() {
  const { user, impersonatedBy, stopImpersonation } = useAuth();
  if (!impersonatedBy || !user) return null;
  return (
    <div className="bg-amber-100 border-b border-amber-300 text-amber-900 text-sm">
      <div className="max-w-7xl mx-auto px-4 h-9 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">⚠</span>
          <span>
            Acting as <strong>{user.name}</strong> · admin <strong>{impersonatedBy.name}</strong>
          </span>
        </div>
        <button onClick={stopImpersonation}
          className="text-xs font-medium px-3 py-1 rounded-md border border-amber-400 hover:bg-amber-200">
          Stop impersonation
        </button>
      </div>
    </div>
  );
}
