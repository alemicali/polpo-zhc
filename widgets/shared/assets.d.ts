/** Images bundled into the widget document as data URIs (widgets/build.mjs: loader dataurl). */
declare module "*.png" {
  const src: string;
  export default src;
}
