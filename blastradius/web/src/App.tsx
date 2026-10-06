import { BrowserRouter } from 'react-router';
import { AuthProvider } from './auth';
import { ProjectProvider } from './project';
import { AppRoutes } from './routes';
import { ThemeProvider } from './components/theme-provider';
import { Toaster } from './components/ui/sonner';

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProjectProvider>
            <AppRoutes />
          </ProjectProvider>
        </AuthProvider>
      </BrowserRouter>
      <Toaster richColors closeButton />
    </ThemeProvider>
  );
}
