import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    this.setState({ info })
    console.error('B.O.A.R.D. crash:', error, info)
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', {
        style: { padding: 40, fontFamily: 'monospace', background: '#E8ECF2', minHeight: '100vh' }
      },
        React.createElement('h2', { style: { color: '#D4859A' } }, '[;v;] B.O.A.R.D. 遇到了错误'),
        React.createElement('pre', {
          style: { background: '#F4F6FA', padding: 16, borderRadius: 8, overflow: 'auto', fontSize: 13, marginTop: 16 }
        }, String(this.state.error?.stack || this.state.error)),
        React.createElement('button', {
          onClick: () => this.setState({ error: null, info: null }),
          style: { marginTop: 16, padding: '8px 20px', background: '#D4859A', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }
        }, '尝试恢复'),
        React.createElement('button', {
          onClick: () => location.reload(),
          style: { marginTop: 16, marginLeft: 8, padding: '8px 20px', background: '#DCE2EA', color: '#2D3142', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }
        }, '刷新页面')
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  React.createElement(ErrorBoundary, null,
    React.createElement(React.StrictMode, null,
      React.createElement(App)
    )
  )
)
