'use client';
import { useDocsSearch } from 'fumadocs-core/search/client';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
import {
  SearchDialog, SearchDialogClose, SearchDialogContent, SearchDialogHeader,
  SearchDialogIcon, SearchDialogInput, SearchDialogList, SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search';

export default function DocsSearch(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ client: staticClient({ from: '/search-index.json' }) });
  return <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
    <SearchDialogOverlay />
    <SearchDialogContent>
      <SearchDialogHeader><SearchDialogIcon /><SearchDialogInput placeholder="Search skills, commands, and workflows…" /><SearchDialogClose /></SearchDialogHeader>
      <SearchDialogList items={query.data !== 'empty' ? query.data : null} />
      {query.error && <p role="alert" className="p-4 text-sm">Search could not load. Close this dialog and use the sidebar, or try again.</p>}
    </SearchDialogContent>
  </SearchDialog>;
}
