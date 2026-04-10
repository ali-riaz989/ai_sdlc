'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { apiClient } from '@/lib/api';
import socketClient from '@/lib/socket';
import { formatDistanceToNow } from 'date-fns';

const STATUS_STEPS = ['pending', 'analyzing', 'generating_code', 'staging', 'review'];

export default function RequestDetailPage() {
  const { id } = useParams();
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient.getChangeRequest(id)
      .then(res => setRequest(res.data))
      .catch(console.error)
      .finally(() => setLoading(false));

    socketClient.subscribeToChangeRequest(id, (update) => {
      setRequest(prev => prev ? { ...prev, status: update.status } : prev);
    });

    return () => socketClient.unsubscribeFromChangeRequest(id);
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">Request not found.</p>
      </div>
    );
  }

  const currentStep = STATUS_STEPS.indexOf(request.status);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-3">
          <a href="/" className="text-sm text-gray-500 hover:text-gray-900">← Dashboard</a>
          <span className="text-gray-300">/</span>
          <span className="text-sm text-gray-900 font-medium truncate">CR-{id.substring(0, 8)}</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        {/* Details card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-900">{request.title}</h1>
              <p className="text-sm text-gray-500 mt-1">
                {request.project_name} · {request.category} ·{' '}
                {formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
              </p>
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${
              request.status === 'review' ? 'bg-green-100 text-green-700' :
              request.status === 'failed' ? 'bg-red-100 text-red-700' :
              'bg-blue-100 text-blue-700'
            }`}>
              {request.status}
            </span>
          </div>

          <p className="mt-4 text-gray-700 text-sm bg-gray-50 rounded-lg p-4 leading-relaxed">
            {request.prompt}
          </p>
        </div>

        {/* Progress tracker */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Pipeline Progress</h2>
          <div className="flex items-center gap-0">
            {STATUS_STEPS.map((step, i) => (
              <div key={step} className="flex items-center flex-1 last:flex-none">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                  i < currentStep ? 'bg-green-500 text-white' :
                  i === currentStep ? 'bg-blue-600 text-white' :
                  'bg-gray-200 text-gray-400'
                }`}>
                  {i < currentStep ? '✓' : i + 1}
                </div>
                <div className="text-xs text-gray-500 ml-1.5 mr-2 whitespace-nowrap">
                  {step.replace('_', ' ')}
                </div>
                {i < STATUS_STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 mr-2 ${i < currentStep ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Staging link */}
        {request.staging && request.status === 'review' && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-green-800 mb-2">Staging Environment Ready</h2>
            <a
              href={request.staging.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-green-700 hover:underline font-medium break-all"
            >
              {request.staging.url}
            </a>
            <p className="text-xs text-green-600 mt-2">
              Expires {formatDistanceToNow(new Date(request.staging.expires_at), { addSuffix: true })}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
