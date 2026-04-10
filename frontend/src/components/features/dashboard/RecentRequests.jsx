'use client';

import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/api';
import { formatDistanceToNow } from 'date-fns';

const STATUS_BADGE = {
  pending: 'bg-gray-100 text-gray-700',
  analyzing: 'bg-blue-100 text-blue-700',
  generating_code: 'bg-purple-100 text-purple-700',
  staging: 'bg-orange-100 text-orange-700',
  review: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700'
};

export default function RecentRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.listChangeRequests({ limit: 10 })
      .then(res => setRequests(res.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Requests</h3>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-16 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Requests</h3>

      {requests.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No requests yet</p>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <a
              key={req.id}
              href={`/requests/${req.id}`}
              className="block p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-gray-900 truncate flex-1">{req.title}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_BADGE[req.status] || STATUS_BADGE.pending}`}>
                  {req.status}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {req.project_name} · {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
              </p>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
