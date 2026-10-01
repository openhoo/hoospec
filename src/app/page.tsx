import { RepositoryStudio } from '@/components/repository-studio';
import { Studio } from '@/components/studio';

export default function Home() { return process.env.NEXT_PUBLIC_HOOSPEC_PAGES === 'true' ? <RepositoryStudio /> : <Studio />; }
