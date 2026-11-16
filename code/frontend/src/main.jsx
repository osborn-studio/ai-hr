import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class RenderBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="fatal-error"><h1>页面暂时无法显示</h1><p>请重新加载页面。未完成的操作请先检查实际业务状态。</p><button onClick={() => location.reload()}>重新加载</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')).render(<RenderBoundary><App/></RenderBoundary>);
