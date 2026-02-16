
import '/backend/backend.dart';
import '/backend/schema/enums/enums.dart';

import '../../flutter_flow/nav/serialization_util.dart';

dynamic convertAlgoliaParam<T>(
  dynamic data,
  ParamType paramType,
  bool isList, {
  StructBuilder<T>? structBuilder,
}) {
  try {
    if (data == null) {
      return null;
    }
    if (isList) {
      if (data is! Iterable) {
        return null;
      }
      return data
          .map((p) => convertAlgoliaParam<T>(
                p,
                paramType,
                false,
                structBuilder: structBuilder,
              ))
          .where((p) => p != null)
          .map((p) => p! as T)
          .toList();
    }
    switch (paramType) {
      case ParamType.int:
        return isList
            ? (data as Iterable).map((i) => (i as num).round())
            : data?.round();
      case ParamType.double:
        return isList
            ? (data as Iterable).map((d) => (d as num).toDouble())
            : data?.toDouble();
      case ParamType.DateTime:
        return isList
            ? (data as Iterable)
                .map((s) => DateTime.fromMillisecondsSinceEpoch(s))
            : safeGet(() => DateTime.fromMillisecondsSinceEpoch(data));
      case ParamType.LatLng:
        return isList
            ? null
            : safeGet(
                () => LatLng(data['_geoloc']['lat'], data['_geoloc']['lng']),
              );
      case ParamType.Color:
        return isList
            ? (data as Iterable).map((s) => fromCssColor(s))
            : safeGet(() => fromCssColor(data));
      case ParamType.DocumentReference:
        return isList
            ? (data as Iterable).map((s) => toRef(s))
            : safeGet(() => toRef(data));
      case ParamType.DataStruct:
        if (structBuilder == null) {
          return null;
        }
        return isList
            ? (data as Iterable)
                .map((d) => structBuilder((d as Map).cast<String, dynamic>()))
            : structBuilder((data as Map).cast<String, dynamic>());
      case ParamType.Enum:
        return deserializeEnum<T>(data);

      default:
        return data;
    }
  } catch (e) {
    print('Error deserializing parameter: $e');
    return null;
  }
}
