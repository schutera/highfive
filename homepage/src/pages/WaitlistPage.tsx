import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/LanguageContext';
import LanguageToggle from '../components/LanguageToggle';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

type Status = 'idle' | 'submitting' | 'success' | 'error';

export default function WaitlistPage() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === 'submitting') return;
    setStatus('submitting');
    setErrorMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || 'Signup failed');
      }
      setStatus('success');
      setName('');
      setEmail('');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Signup failed');
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-yellow-50 to-orange-50">
      <header className="bg-white shadow-sm px-3 md:px-6 py-2 md:py-4 flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-4">
          <Link
            to="/"
            className="text-lg md:text-2xl font-bold text-amber-600 hover:text-amber-700 flex items-center gap-1"
          >
            <span className="text-xl md:text-2xl">🙌</span>
            <span>HighFive</span>
          </Link>
          <span className="text-gray-300 hidden md:inline">|</span>
          <h1 className="hidden md:block text-xl font-semibold text-gray-800">
            {t('waitlist.pageTitle')}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle />
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
            {t('common.backToHome')}
          </Link>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-12 md:py-20">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-5xl font-bold text-gray-900 mb-3">
            {t('waitlist.heroTitle')}
          </h1>
          <p className="text-base md:text-lg text-gray-600">
            {t('waitlist.heroText')}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg border border-amber-100 p-6 md:p-8">
          {status === 'success' ? (
            <div className="text-center py-6">
              <div className="text-5xl mb-3">🎉</div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                {t('waitlist.successTitle')}
              </h2>
              <p className="text-gray-600 mb-6">{t('waitlist.successText')}</p>
              <Link
                to="/"
                className="inline-block bg-amber-500 hover:bg-amber-600 text-white px-6 py-3 rounded-lg font-semibold transition-colors"
              >
                {t('common.backToHome')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="waitlist-name" className="block text-sm font-semibold text-gray-700 mb-1">
                  {t('waitlist.nameLabel')}
                </label>
                <input
                  id="waitlist-name"
                  type="text"
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-400 focus:border-amber-400 outline-none"
                  placeholder={t('waitlist.namePlaceholder')}
                  disabled={status === 'submitting'}
                />
              </div>

              <div>
                <label htmlFor="waitlist-email" className="block text-sm font-semibold text-gray-700 mb-1">
                  {t('waitlist.emailLabel')}
                </label>
                <input
                  id="waitlist-email"
                  type="email"
                  required
                  maxLength={320}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-amber-400 focus:border-amber-400 outline-none"
                  placeholder={t('waitlist.emailPlaceholder')}
                  disabled={status === 'submitting'}
                />
              </div>

              {status === 'error' && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                  {errorMsg || t('waitlist.errorGeneric')}
                </div>
              )}

              <button
                type="submit"
                disabled={status === 'submitting'}
                className="w-full bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 disabled:cursor-not-allowed text-white py-3 rounded-lg font-semibold transition-colors"
              >
                {status === 'submitting' ? t('waitlist.submitting') : t('waitlist.submit')}
              </button>

              <p className="text-xs text-gray-500 text-center">
                {t('waitlist.privacy')}
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
