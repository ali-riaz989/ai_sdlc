'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import RecentRequests from '@/components/features/dashboard/RecentRequests';
import AddProjectModal from '@/components/features/projects/AddProjectModal';

export default function Home() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [showAddProject, setShowAddProject] = useState(false);
  const [setupProject, setSetupProject] = useState(null);

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;

    const fetchProjects = () =>
      apiClient.getProjects()
        .then(res => setProjects(res.data))
        .catch(console.error)
        .finally(() => setProjectsLoading(false));

    fetchProjects();

    // Poll every 5s while any project is still setting up
    const interval = setInterval(() => {
      setProjects(prev => {
        const busy = prev.some(p => ['setting_up', 'cloning'].includes(p.status));
        if (busy) fetchProjects();
        return prev;
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [user]);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-gray-900">AI SDLC Platform</h1>
          <div className="flex items-center gap-4">
            <a href="/projects" className="text-sm text-gray-600 hover:text-gray-900">Projects</a>
            <span className="text-sm text-gray-500">{user.name}</span>
            <button
              onClick={logout}
              className="text-sm text-gray-500 hover:text-gray-900"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
            <p className="text-gray-500 text-sm mt-1">
              Describe a change in plain English — AI will generate and deploy it.
            </p>
          </div>
          {user.role === 'admin' && (
            <button
              onClick={() => setShowAddProject(true)}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
            >
              + Connect Repo
            </button>
          )}
        </div>

        {/* Projects needing setup */}
        {projects.filter(p => !p.project_url && ['active', 'setup_failed', 'setting_up', 'cloning'].includes(p.status)).length > 0 && (
          <div className="mb-6 space-y-2">
            {projects.filter(p => !p.project_url && ['active', 'setup_failed', 'setting_up', 'cloning'].includes(p.status)).map(p => (
              <div key={p.id} className={`flex items-center justify-between rounded-lg px-4 py-3 border ${
                p.status === 'setup_failed' ? 'bg-red-50 border-red-200' :
                p.status === 'setting_up' || p.status === 'cloning' ? 'bg-blue-50 border-blue-200' :
                'bg-amber-50 border-amber-200'
              }`}>
                <div className="min-w-0 flex-1 mr-4 flex items-center gap-3">
                  {(p.status === 'setting_up' || p.status === 'cloning') && (
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  )}
                  <div>
                    <span className={`font-medium ${p.status === 'setup_failed' ? 'text-red-900' : p.status === 'setting_up' || p.status === 'cloning' ? 'text-blue-900' : 'text-amber-900'}`}>{p.display_name}</span>
                    <span className={`text-sm ml-2 ${p.status === 'setup_failed' ? 'text-red-700' : p.status === 'setting_up' || p.status === 'cloning' ? 'text-blue-700' : 'text-amber-700'}`}>
                      {p.status === 'setup_failed' ? '— setup failed' :
                       p.status === 'setting_up' ? '— installing dependencies…' :
                       p.status === 'cloning' ? '— cloning repository…' :
                       '— not yet deployed'}
                    </span>
                    {p.status === 'setup_failed' && p.setup_error && (
                      <p className="text-xs text-red-600 mt-1 font-mono break-all">{p.setup_error}</p>
                    )}
                  </div>
                </div>
                {user.role === 'admin' && (
                  <button
                    onClick={() => setSetupProject(p)}
                    className={`px-3 py-1.5 text-white text-sm font-medium rounded-lg flex-shrink-0 ${
                      p.status === 'setup_failed' ? 'bg-red-600 hover:bg-red-700' :
                      p.status === 'setting_up'  ? 'bg-blue-600 hover:bg-blue-700' :
                      'bg-amber-600 hover:bg-amber-700'
                    }`}
                  >
                    {p.status === 'setup_failed' ? 'Retry Setup' :
                     p.status === 'setting_up'   ? 'View Terminal' :
                     'Complete Setup'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {projects.filter(p => p.project_url).length === 0 && !projectsLoading ? (
          <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
            <p className="text-gray-500 mb-4">No projects deployed yet.</p>
            {user.role === 'admin' && (
              <button
                onClick={() => setShowAddProject(true)}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
              >
                Connect a Git Repository
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Deployed projects list */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.filter(p => p.project_url).map(p => (
                <div key={p.id} className="bg-white rounded-xl border border-gray-200 p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-gray-900">{p.display_name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 font-mono truncate">{p.project_url}</p>
                    </div>
                    <span className="flex-shrink-0 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">Live</span>
                  </div>
                  <a
                    href={`/projects/${p.id}`}
                    className="w-full text-center py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Open & Edit →
                  </a>
                </div>
              ))}
            </div>

            {/* Recent change requests — full-width listing under the projects grid */}
            <RecentRequests />
          </div>
        )}
      </main>

      {showAddProject && (
        <AddProjectModal
          onClose={() => setShowAddProject(false)}
          onAdded={(project) => {
            setProjects(prev => [project, ...prev]);
            setShowAddProject(false);
          }}
        />
      )}

      {setupProject && (
        <AddProjectModal
          existingProject={setupProject}
          startStep={setupProject.status === 'setting_up' ? 'setting-up' : undefined}
          onClose={() => setSetupProject(null)}
          onAdded={(updated) => {
            setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
            setSetupProject(null);
          }}
        />
      )}
    </div>
  );
}
