import { createRoot } from 'react-dom/client'
import { DesktopStartup } from './DesktopStartup.tsx'
import './styles.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Desktop renderer root element is missing.')
createRoot(root).render(<DesktopStartup />)
