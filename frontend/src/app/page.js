'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
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
      <div className="flex items-center justify-center min-h-screen bg-[#f9f9f9]">
        <div className="text-[#564338] text-sm">Loading…</div>
      </div>
    );
  }

  const navLink = "text-[11px] font-semibold tracking-[0.1em] text-[#1a1c1c] hover:text-[#9b4600] transition-colors";

  return (
    <div className="min-h-screen bg-[#f9f9f9] flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-[#e2e2e2] sticky top-0 z-10">
        <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
          <img
            src="/The-Parklane-Canvas-Logo.png"
            alt="The Parklane Canvas"
            className="h-9 w-auto"
          />
          <div className="flex items-center gap-8">
            {user.role === 'admin' && (
              <>
                <a href="/users" className={navLink}>USERS</a>
                <a href="/admin/logs" className={navLink}>ADMIN</a>
              </>
            )}
            <button onClick={logout} className={navLink}>
              LOGOUT
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 max-w-[1280px] mx-auto w-full px-6 py-12">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <h2 className="font-[var(--font-eb-garamond)] text-5xl font-medium text-[#1a1c1c] tracking-tight leading-tight">
              Dashboard
            </h2>
            <p className="text-[#564338] text-sm mt-2">
              Describe a change in plain English — AI will generate and deploy it.
            </p>
          </div>
          {user.role === 'admin' && (
            <button
              onClick={() => setShowAddProject(true)}
              className="px-5 h-10 bg-[#f6863d] text-white text-sm font-semibold rounded hover:bg-[#9b4600] transition-colors flex items-center gap-2 flex-shrink-0"
            >
              <span className="text-lg leading-none">+</span> Connect Repo
            </button>
          )}
        </div>

        {/* Projects needing setup */}
        {projects.filter(p => !p.project_url && ['active', 'setup_failed', 'setting_up', 'cloning'].includes(p.status)).length > 0 && (
          <div className="mb-8 space-y-2">
            {projects.filter(p => !p.project_url && ['active', 'setup_failed', 'setting_up', 'cloning'].includes(p.status)).map(p => (
              <div key={p.id} className={`flex items-center justify-between rounded-lg px-4 py-3 border ${
                p.status === 'setup_failed' ? 'bg-[#ffdad6] border-[#ffb4ab]' :
                p.status === 'setting_up' || p.status === 'cloning' ? 'bg-[#fff2e6] border-[#f6cdb0]' :
                'bg-[#fff8ec] border-[#f0dcb8]'
              }`}>
                <div className="min-w-0 flex-1 mr-4 flex items-center gap-3">
                  {(p.status === 'setting_up' || p.status === 'cloning') && (
                    <div className="w-4 h-4 border-2 border-[#9b4600] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  )}
                  <div>
                    <span className={`font-medium ${p.status === 'setup_failed' ? 'text-[#93000a]' : 'text-[#622a00]'}`}>{p.display_name}</span>
                    <span className={`text-sm ml-2 ${p.status === 'setup_failed' ? 'text-[#93000a]' : 'text-[#763300]'}`}>
                      {p.status === 'setup_failed' ? '— setup failed' :
                       p.status === 'setting_up' ? '— installing dependencies…' :
                       p.status === 'cloning' ? '— cloning repository…' :
                       '— not yet deployed'}
                    </span>
                    {p.status === 'setup_failed' && p.setup_error && (
                      <p className="text-xs text-[#93000a] mt-1 font-mono break-all">{p.setup_error}</p>
                    )}
                  </div>
                </div>
                {user.role === 'admin' && (
                  <button
                    onClick={() => setSetupProject(p)}
                    className={`px-3 h-9 text-white text-sm font-semibold rounded flex-shrink-0 transition-colors ${
                      p.status === 'setup_failed' ? 'bg-[#ba1a1a] hover:bg-[#93000a]' :
                      'bg-[#f6863d] hover:bg-[#9b4600]'
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
          <div className="bg-white rounded-lg border border-dashed border-[#ddc1b3] p-12 text-center">
            <p className="text-[#564338] mb-4 text-sm">No projects deployed yet.</p>
            {user.role === 'admin' && (
              <button
                onClick={() => setShowAddProject(true)}
                className="px-5 h-10 bg-[#f6863d] text-white text-sm font-semibold rounded hover:bg-[#9b4600] transition-colors"
              >
                Connect a Git Repository
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.filter(p => p.project_url).map(p => (
              <div
                key={p.id}
                className="bg-white rounded-lg border border-[#e2e2e2] p-6 flex flex-col gap-6 min-h-[200px]"
                style={{ boxShadow: '0 1px 2px rgba(26,28,28,0.03)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <div className="w-8 h-8 rounded bg-[#f3f3f4] border border-[#e2e2e2] flex items-center justify-center flex-shrink-0 text-[11px] font-semibold text-[#564338]">
                      {(p.display_name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#1a1c1c] truncate leading-tight">{p.display_name}</p>
                      <p className="text-[11px] text-[#897266] mt-0.5 font-mono truncate">{p.project_url}</p>
                    </div>
                  </div>
                  <span className="flex-shrink-0 text-[10px] font-semibold tracking-wider uppercase bg-[#dcf3e1] text-[#1f6b3a] px-2 py-0.5 rounded-full">
                    Live
                  </span>
                </div>
                <a
                  href={`/projects/${p.id}`}
                  className="mt-auto w-full text-center h-12 leading-[3rem] bg-[#f6863d] text-white text-sm font-semibold rounded hover:bg-[#9b4600] transition-colors"
                >
                  Open & Edit →
                </a>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#e2e2e2] bg-white mt-12">
        <div className="max-w-[1280px] mx-auto px-6 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.1em] text-[#9b4600]">
              THE PARKLANE GROUP
            </p>
            <p className="text-xs text-[#897266] mt-1">
              © {new Date().getFullYear()} The Parklane Group. Powered by Enterprise AI.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <a href="#" className="text-[11px] font-semibold tracking-[0.1em] text-[#564338] hover:text-[#9b4600] transition-colors">PRIVACY POLICY</a>
            <a href="#" className="text-[11px] font-semibold tracking-[0.1em] text-[#564338] hover:text-[#9b4600] transition-colors">TERMS OF SERVICE</a>
            <a href="#" className="text-[11px] font-semibold tracking-[0.1em] text-[#564338] hover:text-[#9b4600] transition-colors">SECURITY</a>
            <a href="#" className="text-[11px] font-semibold tracking-[0.1em] text-[#564338] hover:text-[#9b4600] transition-colors">HELP CENTER</a>
          </div>
        </div>
      </footer>

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
