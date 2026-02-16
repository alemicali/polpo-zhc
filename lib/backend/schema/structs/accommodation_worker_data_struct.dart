// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import '/flutter_flow/flutter_flow_util.dart';

class AccommodationWorkerDataStruct extends FFFirebaseStruct {
  AccommodationWorkerDataStruct({
    String? accommodationName,
    DocumentReference? ref,
    DocumentReference? accomodation,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _accommodationName = accommodationName,
        _ref = ref,
        _accomodation = accomodation,
        super(firestoreUtilData);

  // "accommodationName" field.
  String? _accommodationName;
  String get accommodationName => _accommodationName ?? '';
  set accommodationName(String? val) => _accommodationName = val;

  bool hasAccommodationName() => _accommodationName != null;

  // "ref" field.
  DocumentReference? _ref;
  DocumentReference? get ref => _ref;
  set ref(DocumentReference? val) => _ref = val;

  bool hasRef() => _ref != null;

  // "accomodation" field.
  DocumentReference? _accomodation;
  DocumentReference? get accomodation => _accomodation;
  set accomodation(DocumentReference? val) => _accomodation = val;

  bool hasAccomodation() => _accomodation != null;

  static AccommodationWorkerDataStruct fromMap(Map<String, dynamic> data) =>
      AccommodationWorkerDataStruct(
        accommodationName: data['accommodationName'] as String?,
        ref: data['ref'] as DocumentReference?,
        accomodation: data['accomodation'] as DocumentReference?,
      );

  static AccommodationWorkerDataStruct? maybeFromMap(dynamic data) =>
      data is Map
          ? AccommodationWorkerDataStruct.fromMap(data.cast<String, dynamic>())
          : null;

  Map<String, dynamic> toMap() => {
        'accommodationName': _accommodationName,
        'ref': _ref,
        'accomodation': _accomodation,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'accommodationName': serializeParam(
          _accommodationName,
          ParamType.String,
        ),
        'ref': serializeParam(
          _ref,
          ParamType.DocumentReference,
        ),
        'accomodation': serializeParam(
          _accomodation,
          ParamType.DocumentReference,
        ),
      }.withoutNulls;

  static AccommodationWorkerDataStruct fromSerializableMap(
          Map<String, dynamic> data) =>
      AccommodationWorkerDataStruct(
        accommodationName: deserializeParam(
          data['accommodationName'],
          ParamType.String,
          false,
        ),
        ref: deserializeParam(
          data['ref'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['accomodationWorkers'],
        ),
        accomodation: deserializeParam(
          data['accomodation'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['accomodations'],
        ),
      );

  static AccommodationWorkerDataStruct fromAlgoliaData(
          Map<String, dynamic> data) =>
      AccommodationWorkerDataStruct(
        accommodationName: convertAlgoliaParam(
          data['accommodationName'],
          ParamType.String,
          false,
        ),
        ref: convertAlgoliaParam(
          data['ref'],
          ParamType.DocumentReference,
          false,
        ),
        accomodation: convertAlgoliaParam(
          data['accomodation'],
          ParamType.DocumentReference,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'AccommodationWorkerDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    return other is AccommodationWorkerDataStruct &&
        accommodationName == other.accommodationName &&
        ref == other.ref &&
        accomodation == other.accomodation;
  }

  @override
  int get hashCode =>
      const ListEquality().hash([accommodationName, ref, accomodation]);
}

AccommodationWorkerDataStruct createAccommodationWorkerDataStruct({
  String? accommodationName,
  DocumentReference? ref,
  DocumentReference? accomodation,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    AccommodationWorkerDataStruct(
      accommodationName: accommodationName,
      ref: ref,
      accomodation: accomodation,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

AccommodationWorkerDataStruct? updateAccommodationWorkerDataStruct(
  AccommodationWorkerDataStruct? accommodationWorkerData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    accommodationWorkerData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addAccommodationWorkerDataStructData(
  Map<String, dynamic> firestoreData,
  AccommodationWorkerDataStruct? accommodationWorkerData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (accommodationWorkerData == null) {
    return;
  }
  if (accommodationWorkerData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields = !forFieldValue &&
      accommodationWorkerData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final accommodationWorkerDataData = getAccommodationWorkerDataFirestoreData(
      accommodationWorkerData, forFieldValue);
  final nestedData =
      accommodationWorkerDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields =
      accommodationWorkerData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getAccommodationWorkerDataFirestoreData(
  AccommodationWorkerDataStruct? accommodationWorkerData, [
  bool forFieldValue = false,
]) {
  if (accommodationWorkerData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(accommodationWorkerData.toMap());

  // Add any Firestore field values
  accommodationWorkerData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getAccommodationWorkerDataListFirestoreData(
  List<AccommodationWorkerDataStruct>? accommodationWorkerDatas,
) =>
    accommodationWorkerDatas
        ?.map((e) => getAccommodationWorkerDataFirestoreData(e, true))
        .toList() ??
    [];
