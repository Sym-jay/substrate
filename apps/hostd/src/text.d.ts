// Shell scripts bundled as text (`import script from './x.sh' with { type: 'text' }`).
declare module '*.sh' {
  const text: string
  export default text
}
