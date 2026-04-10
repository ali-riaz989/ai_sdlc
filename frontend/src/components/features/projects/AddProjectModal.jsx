'use client';

import { useState, useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api';
import api from '@/lib/api';
import socketClient from '@/lib/socket';

// Steps: form → cloning → db-type → db-action → setting-up → done

export default function AddProjectModal({ onClose, onAdded, existingProject, startStep }) {
  const [step, setStep] = useState(startStep || (existingProject ? 'db-type' : 'form'));
  const [project, setProject] = useState(existingProject || null);
  const [form, setForm] = useState({
    display_name: '', name: '', repo_url: '',
    repo_branch: 'main', production_url: '', git_token: ''
  });
  const [dbType, setDbType] = useState('postgres');
  const [setupAction, setSetupAction] = useState('migrate');
  const [dbFile, setDbFile] = useState(null);
  const [envContent, setEnvContent] = useState('');
  const [envInputMode, setEnvInputMode] = useState('paste'); // 'paste' | 'upload'
  const [error, setError] = useState('');
  const [logs, setLogs] = useState([]);
  const [question, setQuestion] = useState(null); // { question, options }
  const pollRef = useRef(null);
  const logsEndRef = useRef(null);

  // Subscribe to live setup logs + questions via WebSocket
  useEffect(() => {
    if (step !== 'setting-up' || !project?.id) return;

    setLogs([]);
    setQuestion(null);

    socketClient.subscribeToProjectSetup(
      project.id,
      ({ line, level }) => {
        setLogs(prev => [...prev, { line, level, id: Date.now() + Math.random() }]);
      },
      (q) => {
        setQuestion(q);
      }
    );

    return () => socketClient.unsubscribeFromProjectSetup(project?.id);
  }, [step, project?.id]);

  function answerQuestion(value) {
    socketClient.answerProjectQuestion(project.id, value);
    // Log the answer in the terminal
    const chosen = question?.options?.find(o => o.value === value);
    setLogs(prev => [...prev, { line: `> ${chosen?.label || value}`, level: 'cmd', id: Date.now() }]);
    setQuestion(null);
  }

  // Auto-scroll terminal to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Poll status during async operations
  useEffect(() => {
    if (step !== 'cloning' && step !== 'setting-up') return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await apiClient.getProject(project.id);
        const { status, project_url } = res.data;

        if (step === 'cloning' && status === 'active') {
          clearInterval(pollRef.current);
          setProject(res.data);
          setStep('db-type');
        } else if (step === 'cloning' && status === 'clone_failed') {
          clearInterval(pollRef.current);
          setError('Clone failed. Check the repository URL, branch, and SSH/token access.');
          setStep('form');
        } else if (step === 'setting-up' && status === 'active') {
          clearInterval(pollRef.current);
          setProject({ ...res.data, project_url });
          onAdded(res.data);
          setStep('done');
        } else if (step === 'setting-up' && status === 'setup_failed') {
          clearInterval(pollRef.current);
          setError(res.data.setup_error || 'Setup failed — see terminal output above.');
          setStep('terminal-failed');
        }
      } catch (e) { /* keep polling */ }
    }, 3000);

    return () => clearInterval(pollRef.current);
  }, [step, project]);

  function handleFormChange(e) {
    const { name, value } = e.target;
    setForm(prev => {
      const updated = { ...prev, [name]: value };
      if (name === 'display_name') {
        updated.name = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      return updated;
    });
  }

  async function submitClone(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await apiClient.createProject(form);
      setProject(res.data);
      setStep('cloning');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to connect repository');
    }
  }

  async function submitSetup(e) {
    e.preventDefault();
    setError('');
    setLogs([]);
    try {
      const data = new FormData();
      data.append('db_type', dbType);
      data.append('setup_action', setupAction);
      if (envContent.trim()) data.append('env_content', envContent.trim());
      if (setupAction === 'import' && dbFile) data.append('db_file', dbFile);

      await api.post(`/api/projects/${project.id}/setup`, data, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setStep('setting-up');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start setup');
    }
  }

  const canClose = step === 'form' || step === 'done' || step === 'terminal-failed';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">

        {/* Header */}
        <div className="p-6 border-b border-gray-200 flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {step === 'form'       && 'Connect a Git Repository'}
              {step === 'cloning'    && 'Cloning Repository…'}
              {step === 'db-type'    && 'Select Database'}
              {step === 'db-action'  && 'Database Setup'}
              {step === 'setting-up'      && 'Setting Up…'}
              {step === 'terminal-failed' && 'Setup Failed'}
              {step === 'done'            && 'Project Ready!'}
            </h2>
            {/* Step indicator */}
            {!['cloning','setting-up'].includes(step) && (
              <div className="flex gap-1.5 mt-2">
                {['form','db-type','db-action','done'].map((s, i) => (
                  <div key={s} className={`h-1 w-8 rounded-full ${
                    ['form','db-type','db-action','done'].indexOf(step) >= i
                      ? 'bg-blue-500' : 'bg-gray-200'
                  }`} />
                ))}
              </div>
            )}
          </div>
          {canClose && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
          )}
        </div>

        {/* ── STEP 1: Repo form ─────────────────────────────── */}
        {step === 'form' && (
          <form onSubmit={submitClone} className="p-6 space-y-4">
            {error && <p className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</p>}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
              <input name="display_name" value={form.display_name} onChange={handleFormChange}
                placeholder="LGC Phase 2" required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Repository URL</label>
              <input name="repo_url" value={form.repo_url} onChange={handleFormChange}
                placeholder="git@github.com:org/repo.git" required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Branch</label>
                <input name="repo_branch" value={form.repo_branch} onChange={handleFormChange}
                  placeholder="main"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Production URL</label>
                <input name="production_url" value={form.production_url} onChange={handleFormChange}
                  placeholder="https://yoursite.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Git Token <span className="text-gray-400 text-xs">(HTTPS private repos only — leave blank for SSH)</span>
              </label>
              <input name="git_token" type="password" value={form.git_token} onChange={handleFormChange}
                placeholder="ghp_xxxx"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm" />
            </div>

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit"
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                Clone Repository
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 2: Cloning spinner ───────────────────────── */}
        {step === 'cloning' && (
          <div className="p-10 text-center space-y-4">
            <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="font-medium text-gray-900">Cloning {project?.display_name}…</p>
            <p className="text-sm text-gray-500">This may take a minute for large repositories.</p>
          </div>
        )}

        {/* ── STEP 3: DB type ───────────────────────────────── */}
        {step === 'db-type' && (
          <div className="p-6 space-y-5">
            <p className="text-sm text-gray-600">
              Repository cloned. The database will be <strong>created automatically on this server</strong>. Which database engine does this project use?
            </p>

            <div className="grid grid-cols-2 gap-4">
              {[
                { type: 'postgres', label: 'PostgreSQL', icon: '🐘', desc: 'Already running on this server' },
                { type: 'mysql',    label: 'MySQL',      icon: '🐬', desc: 'Requires MySQL installed locally' }
              ].map(({ type, label, icon, desc }) => (
                <button key={type} type="button"
                  onClick={() => { setDbType(type); setStep('db-action'); }}
                  className="p-5 border-2 border-gray-200 rounded-xl text-left hover:border-blue-500 hover:bg-blue-50 transition-colors">
                  <p className="text-2xl mb-2">{icon}</p>
                  <p className="font-semibold text-gray-900">{label}</p>
                  <p className="text-xs text-gray-500 mt-1">{desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── STEP 4: DB action ─────────────────────────────── */}
        {step === 'db-action' && (
          <form onSubmit={submitSetup} className="p-6 space-y-5">
            {error && <p className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</p>}

            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
              A new <strong>{dbType === 'postgres' ? 'PostgreSQL' : 'MySQL'}</strong> database will be created automatically on this server for <strong>{project?.display_name}</strong>.
            </div>

            {/* .env file */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-gray-700">Project .env file</label>
                <div className="flex gap-2">
                  {['paste', 'upload'].map(mode => (
                    <button key={mode} type="button" onClick={() => setEnvInputMode(mode)}
                      className={`text-xs px-2 py-1 rounded ${envInputMode === mode ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:text-gray-700'}`}>
                      {mode === 'paste' ? 'Paste' : 'Upload file'}
                    </button>
                  ))}
                </div>
              </div>

              {envInputMode === 'paste' ? (
                <textarea
                  value={envContent}
                  onChange={e => setEnvContent(e.target.value)}
                  rows={8}
                  placeholder={`APP_NAME=Laravel\nAPP_KEY=base64:...\n\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=my_db\nDB_USERNAME=my_user\nDB_PASSWORD=secret`}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-xs font-mono"
                />
              ) : (
                <input type="file" accept=".env,text/plain"
                  onChange={async e => {
                    const file = e.target.files[0];
                    if (file) setEnvContent(await file.text());
                  }}
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
              )}
              <p className="text-xs text-gray-400">Leave blank to auto-generate. If provided, this will be written as-is to the project directory.</p>
            </div>

            {/* Setup method */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">How should the database be set up?</label>
              <div className="flex gap-3">
                {[
                  { value: 'migrate',     label: 'Run Migrations',    desc: 'Create DB + php artisan migrate' },
                  { value: 'import',      label: 'Upload SQL File',   desc: 'Create DB + restore from .sql dump' },
                  { value: 'env_only',    label: 'Use Existing DB',   desc: 'Just use the DB creds from .env — skip DB creation' }
                ].map(({ value, label, desc }) => (
                  <button key={value} type="button"
                    onClick={() => setSetupAction(value)}
                    className={`flex-1 p-3 border-2 rounded-xl text-left transition-colors ${
                      setupAction === value ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <p className="font-medium text-sm text-gray-900">{label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {setupAction === 'import' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">SQL Dump File</label>
                <input type="file" accept=".sql,.gz"
                  onChange={e => setDbFile(e.target.files[0])} required
                  className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
              </div>
            )}

            {setupAction === 'env_only' && !envContent.trim() && (
              <p className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                Please provide your .env file above — it must contain the DB connection details for your existing database.
              </p>
            )}

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={() => setStep('db-type')}
                className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">
                ← Back
              </button>
              <button type="submit"
                disabled={setupAction === 'env_only' && !envContent.trim()}
                className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {setupAction === 'migrate' ? 'Create DB & Migrate' : setupAction === 'import' ? 'Create DB & Import' : 'Setup with .env'}
              </button>
            </div>
          </form>
        )}

        {/* ── STEP 5 / 5b: Live terminal (running or failed) ── */}
        {(step === 'setting-up' || step === 'terminal-failed') && (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              {step === 'setting-up'
                ? <div className="w-3 h-3 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
                : <span className="text-red-500">✕</span>}
              <p className="text-sm font-medium text-gray-700">
                {step === 'setting-up' ? `Setting up ${project?.display_name}…` : `Setup failed`}
              </p>
            </div>
            {step === 'terminal-failed' && error && (
              <p className="text-xs text-red-600 font-mono bg-red-50 border border-red-200 rounded p-2 break-all">{error}</p>
            )}
            <div className="bg-gray-950 rounded-lg overflow-hidden">
              <div className="flex gap-1.5 px-3 py-2 border-b border-gray-800">
                <span className="w-3 h-3 rounded-full bg-red-500" />
                <span className="w-3 h-3 rounded-full bg-yellow-500" />
                <span className="w-3 h-3 rounded-full bg-green-500" />
              </div>
              <div className="h-72 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
                {logs.length === 0 && (
                  <p className="text-gray-500">Waiting for output…</p>
                )}
                {logs.map(({ line, level, id }) => (
                  <p key={id} className={
                    level === 'error'   ? 'text-red-400' :
                    level === 'success' ? 'text-green-400' :
                    level === 'ai'      ? 'text-purple-400' :
                    level === 'cmd'     ? 'text-yellow-300' :
                    level === 'warn'    ? 'text-orange-300' :
                    'text-gray-300'
                  }>{line}</p>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Interactive question prompt */}
            {question && step === 'setting-up' && (
              <div className="border border-purple-300 bg-purple-50 rounded-lg p-4 space-y-3">
                <div className="flex gap-2 items-start">
                  <span className="text-purple-600 text-lg">🤖</span>
                  <p className="text-sm text-purple-900 whitespace-pre-wrap font-medium">{question.question}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {question.options.map(opt => (
                    <button key={opt.value} onClick={() => answerQuestion(opt.value)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        opt.value === 'abort'
                          ? 'bg-red-100 text-red-700 hover:bg-red-200'
                          : opt.value === 'skip'
                          ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          : 'bg-purple-600 text-white hover:bg-purple-700'
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 'terminal-failed' && (
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => { setStep('db-action'); setError(''); }}
                  className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">
                  ← Change Settings
                </button>
                <button type="button" onClick={() => submitSetup({ preventDefault: () => {} })}
                  className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                  Retry Setup
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── STEP 6: Done ──────────────────────────────────── */}
        {step === 'done' && (
          <div className="p-8 text-center space-y-5">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto text-4xl">✓</div>
            <div>
              <p className="font-semibold text-gray-900 text-lg">{project?.display_name} is live!</p>
              <p className="text-sm text-gray-500 mt-1">Your project is running at:</p>
            </div>
            <a href={project?.project_url} target="_blank" rel="noopener noreferrer"
              className="block px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-blue-600 font-mono text-sm hover:bg-gray-100 break-all">
              {project?.project_url}
            </a>
            <p className="text-xs text-gray-400">You can now submit change requests for this project.</p>
            <button onClick={onClose}
              className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
              Go to Dashboard
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
