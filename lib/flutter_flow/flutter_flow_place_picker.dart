import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_google_places/flutter_google_places.dart';
import 'package:google_api_headers/google_api_headers.dart';
import 'package:google_maps_webservice/places.dart';
import 'package:collection/collection.dart';

import 'flutter_flow_widgets.dart';
import 'lat_lng.dart';
import 'place.dart';

class FlutterFlowPlacePicker extends StatefulWidget {
  const FlutterFlowPlacePicker({
    Key? key,
    required this.iOSGoogleMapsApiKey,
    required this.androidGoogleMapsApiKey,
    required this.webGoogleMapsApiKey,
    required this.defaultText,
    this.icon,
    required this.buttonOptions,
    required this.onSelect,
    this.proxyBaseUrl,
  }) : super(key: key);

  final String iOSGoogleMapsApiKey;
  final String androidGoogleMapsApiKey;
  final String webGoogleMapsApiKey;
  final String? defaultText;
  final Widget? icon;
  final FFButtonOptions buttonOptions;
  final Function(FFPlace place) onSelect;
  final String? proxyBaseUrl;

  @override
  _FFPlacePickerState createState() => _FFPlacePickerState();
}

class _FFPlacePickerState extends State<FlutterFlowPlacePicker> {
  String? _selectedPlace;

  String get googleMapsApiKey {
    if (kIsWeb) {
      return widget.webGoogleMapsApiKey;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.macOS:
      case TargetPlatform.windows:
        return '';
      case TargetPlatform.iOS:
        return widget.iOSGoogleMapsApiKey;
      case TargetPlatform.android:
        return widget.androidGoogleMapsApiKey;
      default:
        return widget.webGoogleMapsApiKey;
    }
  }

  @override
  Widget build(BuildContext context) {
    String? languageCode = Localizations.localeOf(context).languageCode;
    return FFButtonWidget(
      text: _selectedPlace ?? widget.defaultText ?? 'Search places',
      icon: widget.icon,
      onPressed: () async {
        final p = await PlacesAutocomplete.show(
          context: context,
          apiKey: googleMapsApiKey,
          onError: (response) =>
              print('Error occured when getting places response:'
                  '\n${response.errorMessage}'),
          mode: Mode.overlay,
          types: [],
          components: [],
          strictbounds: false,
          proxyBaseUrl: widget.proxyBaseUrl,
          language: languageCode,
        );

        await displayPrediction(p, languageCode);
      },
      options: widget.buttonOptions,
    );
  }

  Future displayPrediction(Prediction? p, String? languageCode) async {
    if (p == null) {
      return;
    }
    final placeId = p.placeId;
    if (placeId == null) {
      return;
    }
    GoogleMapsPlaces _places = GoogleMapsPlaces(
      apiKey: googleMapsApiKey,
      baseUrl: widget.proxyBaseUrl,
      apiHeaders: await const GoogleApiHeaders().getHeaders(),
    );
    PlacesDetailsResponse detail =
        await _places.getDetailsByPlaceId(placeId, language: languageCode);
    if (mounted) {
      setState(() {
        _selectedPlace = detail.result.name;
      });
    }

    widget.onSelect(
      FFPlace(
        latLng: LatLng(
          detail.result.geometry?.location.lat ?? 0,
          detail.result.geometry?.location.lng ?? 0,
        ),
        name: detail.result.name,
        address: detail.result.formattedAddress ?? '',
        city: detail.result.addressComponents
                .firstWhereOrNull((e) => e.types.contains('locality'))
                ?.shortName ??
            detail.result.addressComponents
                .firstWhereOrNull((e) => e.types.contains('sublocality'))
                ?.shortName ??
            '',
        state: detail.result.addressComponents
                .firstWhereOrNull(
                    (e) => e.types.contains('administrative_area_level_1'))
                ?.shortName ??
            '',
        country: detail.result.addressComponents
                .firstWhereOrNull((e) => e.types.contains('country'))
                ?.shortName ??
            '',
        zipCode: detail.result.addressComponents
                .firstWhereOrNull((e) => e.types.contains('postal_code'))
                ?.shortName ??
            '',
      ),
    );
  }
}
