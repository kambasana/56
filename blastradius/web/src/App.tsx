import { BrowserRouter } from 'react-router';
import { AuthProvider } from './auth';
import { ProjectProvider } from './project';
import { AppRoutes } from './routes';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ProjectProvider>
          <AppRoutes />
        </ProjectProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
