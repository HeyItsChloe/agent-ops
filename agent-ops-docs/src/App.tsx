import { HashRouter, Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { ApiReference } from './pages/ApiReference';
import { AppList } from './pages/AppList';
import { CiCd } from './pages/CiCd';
import { Automation } from './pages/Automation';
import { Tests } from './pages/Tests';
import { DocsPage } from './pages/DocsPage';
import { Features } from './pages/Features';
import { Skills } from './pages/Skills';
import { Dependencies } from './pages/Dependencies';
import { Models } from './pages/Models';
import { Configuration } from './pages/Configuration';
import { Changelog } from './pages/Changelog';

// HashRouter (#/features, etc.) per issue #286 - GitHub Pages project sites
// (and the many differently-hosted repos this template targets) have no
// server-side rewrite for deep-linked client-side routes, so this
// deliberately does not switch to BrowserRouter.
//
// Static section routes are declared explicitly; the trailing `:section` /
// `:section/:page` routes catch every markdown navSection (roadmap,
// contributing, ...) generically - React Router ranks the static routes
// above these dynamic ones, so they never shadow a named section.
function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/features" element={<Features />} />
        <Route path="/features/:slug" element={<Features />} />
        <Route path="/api" element={<ApiReference />} />
        <Route path="/api/:group" element={<ApiReference />} />
        <Route path="/apps" element={<AppList />} />
        <Route path="/apps/:app" element={<AppList />} />
        <Route path="/ci-cd" element={<CiCd />} />
        <Route path="/ci-cd/:workflow" element={<CiCd />} />
        <Route path="/automation" element={<Automation />} />
        <Route path="/automation/:pipeline" element={<Automation />} />
        <Route path="/skills" element={<Skills />} />
        <Route path="/skills/:slug" element={<Skills />} />
        <Route path="/tests" element={<Tests />} />
        <Route path="/dependencies" element={<Dependencies />} />
        <Route path="/models" element={<Models />} />
        <Route path="/configuration" element={<Configuration />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/:section/:page" element={<DocsPage />} />
        <Route path="/:section" element={<DocsPage />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
