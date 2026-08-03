import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, Loader2, Search, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { searchQuestionnaires } from '@/fhir/formsServer';
import { useConfig } from '@/lib/ConfigContext';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { useDebounced } from '@/lib/useDebounced';

export default function FormList() {
  const config = useConfig();
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebounced(searchText, 300);

  const {
    data: questionnaires,
    isPending,
    error
  } = useQuery({
    queryKey: ['questionnaires', config.formsServerUrl, debouncedSearch],
    queryFn: ({ signal }) =>
      searchQuestionnaires(config.formsServerUrl, debouncedSearch, 100, signal)
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Forms</h1>
        <p className="text-sm text-slate-500">
          Questionnaires hosted on{' '}
          <span className="font-mono text-xs">{config.formsServerUrl}</span>
        </p>
      </div>

      <div className="relative">
        <Search
          className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-slate-400"
          aria-hidden
        />
        <Input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Search forms by title…"
          className="pl-9"
          aria-label="Search forms by title"
        />
      </div>

      {error ? (
        <Alert tone="error" title="Could not load forms">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      ) : null}

      {isPending ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading forms…
        </p>
      ) : null}

      {questionnaires && questionnaires.length === 0 ? (
        <Alert title="No forms found">
          Nothing matched “{debouncedSearch}”. Forms without any items are hidden, since they cannot
          be rendered.
        </Alert>
      ) : null}

      <ul className="space-y-2">
        {(questionnaires ?? []).map((questionnaire) => (
          <li key={questionnaire.id}>
            <Card className="transition-colors hover:border-slate-400">
              <CardContent className="flex items-start gap-3 p-4">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <Link
                  to={`/fill/${encodeURIComponent(questionnaire.id ?? '')}`}
                  className="min-w-0 flex-1">
                  <p className="font-medium text-slate-900">
                    {questionnaire.title ?? questionnaire.name ?? questionnaire.id}
                  </p>
                  <p className="truncate font-mono text-xs text-slate-500">
                    {questionnaire.url ?? questionnaire.id}
                    {questionnaire.version ? ` | ${questionnaire.version}` : ''}
                  </p>
                </Link>
                <span className="shrink-0 self-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {questionnaire.status}
                </span>
                <Link
                  to={`/request/${encodeURIComponent(questionnaire.id ?? '')}`}
                  className="shrink-0 self-center">
                  <Button variant="outline" size="sm">
                    <Send className="h-3.5 w-3.5" aria-hidden />
                    Request
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
