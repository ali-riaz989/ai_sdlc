'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api';
import socketClient from '@/lib/socket';

const STATUS_LABELS = {
  pending: 'Queued',
  analyzing: 'Analyzing project...',
  generating_code: 'Generating code...',
  staging: 'Deploying to staging...',
  review: 'Ready for review',
  failed: 'Failed'
};

const STATUS_COLORS = {
  pending: 'text-gray-600',
  analyzing: 'text-blue-600',
  generating_code: 'text-purple-600',
  staging: 'text-orange-600',
  review: 'text-green-600',
  failed: 'text-red-600'
};

export default function PromptInterface({ projects }) {
  const [selectedProject, setSelectedProject] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState('content');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedProject || !prompt.trim()) return;

    setLoading(true);
    setResult(null);

    try {
      const response = await apiClient.createChangeRequest({
        project_id: selectedProject,
        title: prompt.substring(0, 100),
        prompt,
        category
      });

      const cr = response.data;

      setResult({
        id: cr.id,
        status: cr.status,
        message: 'Request submitted — processing...',
        stagingUrl: null
      });

      socketClient.subscribeToChangeRequest(cr.id, (update) => {
        setResult(prev => ({
          ...prev,
          status: update.status,
          message: update.message,
          stagingUrl: update.status === 'review' ? update.message?.split(': ')[1] : prev?.stagingUrl
        }));
      });

    } catch (error) {
      alert(error.response?.data?.error || 'Failed to submit request');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h2 className="text-xl font-semibold text-gray-900 mb-5">
        What would you like to change?
      </h2>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Project Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            disabled={loading}
            required
          >
            <option value="">Select a project...</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.display_name}</option>
            ))}
          </select>
        </div>

        {/* Change Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Change Type</label>
          <div className="flex gap-2">
            {['content', 'styling', 'layout'].map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-4 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${
                  category === cat
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt Input */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Describe the change
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            rows={5}
            placeholder='e.g. "Change the homepage hero heading to Welcome to our platform"'
            disabled={loading}
            required
            minLength={10}
            maxLength={5000}
          />
          <p className="text-xs text-gray-400 mt-1">{prompt.length}/5000</p>
        </div>

        <button
          type="submit"
          disabled={loading || !selectedProject || prompt.trim().length < 10}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Submitting...' : 'Submit Change Request'}
        </button>
      </form>

      {/* Progress Display */}
      {result && (
        <div className="mt-5 p-4 rounded-lg border border-gray-200 bg-gray-50">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-mono text-gray-500">CR-{result.id.substring(0, 8)}</p>
              <p className={`font-semibold mt-1 ${STATUS_COLORS[result.status] || 'text-gray-700'}`}>
                {STATUS_LABELS[result.status] || result.status}
              </p>
              <p className="text-sm text-gray-600 mt-1">{result.message}</p>
              {result.stagingUrl && (
                <a
                  href={result.stagingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-2 text-sm text-blue-600 hover:underline font-medium"
                >
                  Open staging preview →
                </a>
              )}
            </div>
            <a
              href={`/requests/${result.id}`}
              className="text-sm text-blue-600 hover:underline whitespace-nowrap"
            >
              View details
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
