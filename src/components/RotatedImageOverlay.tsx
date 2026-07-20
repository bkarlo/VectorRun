"use client";

import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";

type LatLngTuple = [number, number]; // [lat, lon]

/**
 * Leaflet ImageOverlay.Rotated (IvanSanchez) — real map layer, not a raw DOM hack.
 * Three control points: top-left, top-right, bottom-left.
 * @see https://github.com/IvanSanchez/Leaflet.ImageOverlay.Rotated
 */
function ensureRotatedOverlayClass() {
  const ImageOverlayAny = L.ImageOverlay as typeof L.ImageOverlay & {
    Rotated?: typeof L.ImageOverlay;
  };
  if (ImageOverlayAny.Rotated) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Rotated = (L.ImageOverlay.extend as any)({
    initialize(
      this: L.ImageOverlay,
      image: string | HTMLImageElement,
      topleft: L.LatLngExpression,
      topright: L.LatLngExpression,
      bottomleft: L.LatLngExpression,
      options?: L.ImageOverlayOptions
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      if (typeof image === "string") {
        self._url = image;
      } else {
        self._rawImage = image;
      }
      self._topLeft = L.latLng(topleft);
      self._topRight = L.latLng(topright);
      self._bottomLeft = L.latLng(bottomleft);
      L.setOptions(this, options);
    },

    onAdd(this: L.ImageOverlay, map: L.Map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      if (!self._image) {
        self._initImage();
        if ((this.options.opacity ?? 1) < 1) {
          self._updateOpacity();
        }
      }
      map.on("zoomend resetview", self._reset, this);
      this.getPane()!.appendChild(self._image);
      self._reset();
    },

    onRemove(this: L.ImageOverlay, map: L.Map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      map.off("zoomend resetview", self._reset, this);
      L.ImageOverlay.prototype.onRemove.call(this, map);
    },

    _initImage(this: L.ImageOverlay) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      let img: HTMLImageElement = self._rawImage;
      if (self._url) {
        img = L.DomUtil.create("img") as HTMLImageElement;
        img.style.display = "none";
        img.src = self._url;
        self._rawImage = img;
      }
      L.DomUtil.addClass(img, "leaflet-image-layer");

      const div = (self._image = L.DomUtil.create(
        "div",
        "leaflet-image-layer" +
          (self._zoomAnimated ? " leaflet-zoom-animated" : "")
      ));
      self._updateZIndex();
      div.appendChild(img);
      div.onselectstart = L.Util.falseFn;
      div.onmousemove = L.Util.falseFn;

      img.onload = () => {
        self._reset();
        img.style.display = "block";
        self.fire("load");
      };
      img.alt = this.options.alt ?? "";
    },

    _reset(this: L.ImageOverlay) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      const div = self._image as HTMLElement;
      if (!self._map) return;

      const pxTopLeft = self._map.latLngToLayerPoint(self._topLeft);
      const pxTopRight = self._map.latLngToLayerPoint(self._topRight);
      const pxBottomLeft = self._map.latLngToLayerPoint(self._bottomLeft);
      const pxBottomRight = pxTopRight.subtract(pxTopLeft).add(pxBottomLeft);

      const pxBounds = L.bounds([
        pxTopLeft,
        pxTopRight,
        pxBottomLeft,
        pxBottomRight,
      ]);
      const size = pxBounds.getSize();
      const min = pxBounds.min!;
      const max = pxBounds.max!;
      const pxTopLeftInDiv = pxTopLeft.subtract(min);

      self._bounds = L.latLngBounds(
        self._map.layerPointToLatLng(min),
        self._map.layerPointToLatLng(max)
      );

      L.DomUtil.setPosition(div, min);
      div.style.width = size.x + "px";
      div.style.height = size.y + "px";

      const imgW = self._rawImage.width as number;
      const imgH = self._rawImage.height as number;
      if (!imgW || !imgH) return;

      const vectorX = pxTopRight.subtract(pxTopLeft);
      const vectorY = pxBottomLeft.subtract(pxTopLeft);

      self._rawImage.style.transformOrigin = "0 0";
      self._rawImage.style.transform =
        "matrix(" +
        vectorX.x / imgW +
        ", " +
        vectorX.y / imgW +
        ", " +
        vectorY.x / imgH +
        ", " +
        vectorY.y / imgH +
        ", " +
        pxTopLeftInDiv.x +
        ", " +
        pxTopLeftInDiv.y +
        ")";
    },

    reposition(
      this: L.ImageOverlay,
      topleft: L.LatLngExpression,
      topright: L.LatLngExpression,
      bottomleft: L.LatLngExpression
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      self._topLeft = L.latLng(topleft);
      self._topRight = L.latLng(topright);
      self._bottomLeft = L.latLng(bottomleft);
      self._reset();
    },

    setUrl(this: L.ImageOverlay, url: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      self._url = url;
      if (self._rawImage) self._rawImage.src = url;
      return this;
    },
  });

  ImageOverlayAny.Rotated = Rotated;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (L.imageOverlay as any).rotated = (
    imgSrc: string,
    topleft: L.LatLngExpression,
    topright: L.LatLngExpression,
    bottomleft: L.LatLngExpression,
    options?: L.ImageOverlayOptions
  ) => new Rotated(imgSrc, topleft, topright, bottomleft, options);
}

export default function RotatedImageOverlay({
  url,
  topLeft,
  topRight,
  bottomLeft,
  opacity = 0.55,
}: {
  url: string;
  topLeft: LatLngTuple;
  topRight: LatLngTuple;
  bottomLeft: LatLngTuple;
  opacity?: number;
}) {
  const map = useMap();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layerRef = useRef<any>(null);

  // Create once per url
  useEffect(() => {
    ensureRotatedOverlayClass();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (L.imageOverlay as any).rotated(
      url,
      topLeft,
      topRight,
      bottomLeft,
      { opacity, interactive: false }
    );
    layer.addTo(map);
    layerRef.current = layer;
    return () => {
      map.removeLayer(layer);
      layerRef.current = null;
    };
    // Corners/opacity updated below — only remount when url changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.reposition(topLeft, topRight, bottomLeft);
    if (typeof layer.setOpacity === "function") {
      layer.setOpacity(opacity);
    }
  }, [topLeft, topRight, bottomLeft, opacity]);

  return null;
}
